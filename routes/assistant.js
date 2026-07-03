function registerAssistantRoutes(app, deps) {
    const {
        requireAuth,
        aiLimiter,
        isGlobalStyleAssistantStage,
        runAssistantTurn,
        buildGlobalStyleAssistantContext,
        getAssistantModelConfig,
        assertValidProjectId,
        BadRequestError,
        STAGE_NAMES,
        getProjectFilePath,
        readProjectJSONById,
        conversationKeyForAssistantStage,
        buildStageDataForAssistant,
        persistChatAttachmentToKnowledge,
        writeJSONQueued,
        buildKnowledgeContextBlock,
        memoryUsageForStage,
        updateProjectJSON,
        buildStage4CurrentEventListResponse,
        persistStageConversation,
        buildMemoryRecallResponse,
        compactText,
        buildToolAssistantContextAdditions,
        buildStage4ConfirmationBypassResponse,
        buildStage4ConfirmationRevisionBrief,
        buildNeutralMessages,
        trackUsage,
        sendApiError
    } = deps;

    // Tool-calling stage assistant.
    // Two-leg tool turns: a response of {type:'tool_call', turnState} means the browser
    // must execute the revision via its existing executeRevision machinery and POST the
    // result back with the same turnState so the model sees the real receipt.
    // Stage/global chat surfaces now route here.
    app.post('/api/assistant', requireAuth, aiLimiter, async (req, res) => {
        try {
            const { projectId, stageId, messages = [], sceneNumber, attachment, isInit = false, turnState = null, toolResults = null } = req.body;
            if (isGlobalStyleAssistantStage(stageId)) {
                const result = await runAssistantTurn({
                    stageId: 'style_global',
                    contextBlock: turnState ? '' : await buildGlobalStyleAssistantContext(),
                    history: messages,
                    isInit,
                    turnState,
                    toolResults,
                    modelConfig: getAssistantModelConfig(7)
                });
                console.log(`Assistant style_global: type=${result.type}${result.toolCalls ? ` tools=${result.toolCalls.map(c => c.name).join(',')}` : ''}`);
                return res.json({
                    type: result.type,
                    message: result.message,
                    ...(result.toolCalls && { toolCalls: result.toolCalls }),
                    ...(result.turnState && { turnState: result.turnState })
                });
            }

            assertValidProjectId(projectId, 'Missing or invalid projectId or stageId');
            const numericStageId = Number(stageId);
            if (!numericStageId) {
                throw new BadRequestError('Missing or invalid projectId or stageId');
            }
            if (!STAGE_NAMES[numericStageId]) {
                throw new BadRequestError(`Unknown stageId: ${stageId}`);
            }

            const filePath = getProjectFilePath(projectId);
            const projectData = await readProjectJSONById(projectId);
            const pitch = projectData.data?.stage1_pitch?.pitch;
            const title = pitch?.title || projectData.title || 'Untitled';

            const modelConfig = getAssistantModelConfig(numericStageId);
            let savedSource = null;
            let sourceMemory = null;
            let contextBlock = '';
            let historyForTurn = messages;
            const conversationKey = conversationKeyForAssistantStage(numericStageId);

            // Context is only needed on the first leg of a turn; resumed tool turns
            // carry their full message list in turnState.
            if (!turnState) {
                const { stageName, stageData } = await buildStageDataForAssistant(projectData, numericStageId, sceneNumber);

                const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
                let attachmentText = '';
                if (attachment) {
                    const persisted = await persistChatAttachmentToKnowledge(projectData, attachment, { stageId: numericStageId, userMessage: lastUserMessage, projectId });
                    attachmentText = persisted.fileText;
                    savedSource = persisted.savedSource;
                    if (savedSource) await writeJSONQueued(filePath, projectData);
                }

                const knowledgeContext = buildKnowledgeContextBlock(projectData, { stageId: numericStageId, userMessage: lastUserMessage, stageName, stageData });
                sourceMemory = memoryUsageForStage(projectData, numericStageId, stageData, lastUserMessage);
                let stage10InitContext = '';
                if (isInit && numericStageId === 10 && projectData.data?.characterChangeContext) {
                    stage10InitContext = `## CHARACTER CHANGE CONTEXT
The writer just updated character profiles in Stage 3 and chose to send the changes directly to the rewrite stage. Specific changes:
${projectData.data.characterChangeContext}`;
                    delete projectData.data.characterChangeContext;
                    await updateProjectJSON(projectId, (freshProject) => {
                        if (freshProject.data) delete freshProject.data.characterChangeContext;
                        return freshProject;
                    });
                }

                const deterministicStage4EventList = !isInit && numericStageId === 4
                    ? buildStage4CurrentEventListResponse(projectData, lastUserMessage)
                    : null;
                if (deterministicStage4EventList) {
                    await persistStageConversation(filePath, projectData, conversationKey, messages.filter(m => m.role === 'user').slice(-1), deterministicStage4EventList.message);
                    return res.json({
                        type: 'message',
                        message: deterministicStage4EventList.message,
                        ...(savedSource && { savedSource }),
                        ...(sourceMemory && { sourceMemory })
                    });
                }

                const memoryRecall = !isInit ? buildMemoryRecallResponse(projectData, {
                    stageId: numericStageId,
                    stageName,
                    userMessage: lastUserMessage,
                    stageData
                }) : null;
                if (memoryRecall) {
                    await persistStageConversation(filePath, projectData, conversationKey, messages, memoryRecall.message);
                    return res.json({
                        type: 'message',
                        message: memoryRecall.message,
                        ...(savedSource && { savedSource }),
                        ...((memoryRecall.sourceMemory || sourceMemory) && { sourceMemory: memoryRecall.sourceMemory || sourceMemory })
                    });
                }

                const savedConversations = projectData.data?.conversations || {};
                let priorContext = '';
                const lastPriorStage = numericStageId === 10 ? 8 : numericStageId - 1;
                for (let s = 1; s <= lastPriorStage; s++) {
                    const prior = savedConversations[`stage${s}`];
                    if (prior?.length) {
                        priorContext += `\n--- Stage ${s} (${STAGE_NAMES[s]}) Conversations ---\n`;
                        for (const m of prior.slice(-20)) {
                            priorContext += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n`;
                        }
                    }
                }

                contextBlock = `## PROJECT: ${title}\n\n## STAGE ${numericStageId} — ${stageName}\n${stageData}`;
                if (stage10InitContext) contextBlock += `\n\n---\n\n${stage10InitContext}`;
                if (knowledgeContext) contextBlock += `\n\n---\n\n${knowledgeContext}`;
                if (priorContext) contextBlock += `\n\n---\n\n## PREVIOUS STAGE CONVERSATIONS\n${priorContext}`;
                if (attachmentText) contextBlock += `\n\n---\n\n## ATTACHED FILE: ${attachment.name}\n${compactText(attachmentText, 80_000)}`;

                const contextAdditions = buildToolAssistantContextAdditions({
                    projectData,
                    stageId: numericStageId,
                    lastUserMessage,
                    attachmentText,
                    isInit
                });
                if (contextAdditions.context) contextBlock += `\n\n---\n\n${contextAdditions.context}`;
                if (contextAdditions.latestOnly) {
                    historyForTurn = messages.filter(m => m.role === 'user').slice(-1);
                }

                const stage4ConfirmationBypass = !isInit && numericStageId === 4
                    ? buildStage4ConfirmationBypassResponse(messages)
                    : null;
                if (stage4ConfirmationBypass) {
                    const toolCall = {
                        id: `server_stage4_confirmation_${Date.now()}`,
                        name: 'apply_revision',
                        input: { revision_brief: buildStage4ConfirmationRevisionBrief(messages) }
                    };
                    const neutralMessages = buildNeutralMessages({
                        contextBlock,
                        history: historyForTurn,
                        isInit: false,
                        stageId: numericStageId
                    });
                    neutralMessages.push({
                        role: 'assistant',
                        text: stage4ConfirmationBypass.message,
                        toolCalls: [toolCall]
                    });
                    return res.json({
                        type: 'tool_call',
                        message: stage4ConfirmationBypass.message,
                        toolCalls: [toolCall],
                        turnState: JSON.stringify(neutralMessages),
                        ...(savedSource && { savedSource }),
                        ...(sourceMemory && { sourceMemory })
                    });
                }
            }

            const result = await runAssistantTurn({
                stageId: numericStageId,
                contextBlock,
                history: historyForTurn,
                isInit,
                turnState,
                toolResults,
                modelConfig
            });
            console.log(`Assistant stage${stageId}: type=${result.type}${result.toolCalls ? ` tools=${result.toolCalls.map(c => c.name).join(',')}` : ''}`);
            trackUsage(projectId, result.usageList);

            // Persist conversation only when the turn produced a final message.
            // Tool-turn acknowledgment text lives in turnState and reaches the writer's
            // screen, but only the closing message is added to saved history.
            if (!isInit && result.type === 'message') {
                try {
                    await persistStageConversation(filePath, projectData, conversationKey, historyForTurn, result.message);
                } catch (saveErr) {
                    console.error('Failed to persist assistant conversation:', saveErr.message);
                }
            }

            res.json({
                type: result.type,
                message: result.message,
                ...(result.toolCalls && { toolCalls: result.toolCalls }),
                ...(result.turnState && { turnState: result.turnState }),
                ...(savedSource && { savedSource }),
                ...(sourceMemory && { sourceMemory })
            });
        } catch (error) {
            console.error('assistant error:', error);
            sendApiError(res, error, 'Assistant request failed');
        }
    });
}

module.exports = {
    registerAssistantRoutes
};

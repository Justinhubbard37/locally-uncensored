import { ollamaUrl, localFetch } from "./backend";

/**
 * Minimal non-streaming chat helper — one request, one response, no tools.
 *
 * The legacy ReAct agent that used to fill this file (AGENT_TOOLS,
 * buildReActPrompt, buildJsonRetryPrompt, parseAgentResponse, executeTool, and
 * the AgentView/useAgent/agentStore chain that consumed them) was removed in
 * 2.5.9: it had been dead since the Codex + Agent-workflow stacks replaced it,
 * with zero reachable references. Only this helper survives — still used by
 * useCodex, useAgentChat and the workflow engine for one-shot "give me the
 * whole answer at once" calls (plan synthesis, JSON repair) where streaming
 * and the tool loop are not wanted.
 *
 * OLLAMA-ONLY by contract: it posts to the local Ollama endpoint, so `model`
 * must be a locally installed tag. Every caller reaches it from a
 * strategy === 'hermes_xml' branch, and hermes_xml is now unreachable for cloud
 * providers (see isNativeToolProvider). A cloud model slipping in here used to
 * surface as a bare "Chat API error: 404" from Ollama's model lookup — the 404
 * branch below says that out loud instead.
 */
export async function chatNonStreaming(
  model: string,
  messages: { role: string; content: string }[],
  signal?: AbortSignal
): Promise<string> {
  const res = await localFetch(ollamaUrl("/chat"), {
    method: "POST",
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `Model "${model}" is not installed locally (Ollama returned 404). This code path only serves local models.`
      );
    }
    throw new Error(`Chat API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.message?.content || data.response || "";
}

/**
 * Auto Session Naming Extension
 *
 * Automatically names sessions at the start of a conversation. On the first
 * user prompt of an unnamed session, the agent is instructed to call the
 * `name_session` tool to set a short, descriptive name (max 40 characters).
 *
 * Once the session is named, no further naming instructions are injected.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

let injected = false;

export default function (pi: ExtensionAPI) {
	// Reset the injection flag when a session starts. If the session is
	// already named (e.g. continued or resumed), skip future injections.
	pi.on("session_start", async (_event, _ctx) => {
		injected = !!pi.getSessionName();
	});

	// Tool the agent calls to persist the session name.
	pi.registerTool({
		name: "name_session",
		label: "Name Session",
		description:
			"Set a short, descriptive display name for the current session (max 40 characters). " +
			"Base it on the user's initial request — just a few words.",
		parameters: Type.Object({
			name: Type.String({
				description: "Short descriptive session name, max 40 characters",
			}),
		}),
		promptSnippet: "Set the session display name",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			pi.setSessionName(params.name);
			return {
				content: [
					{
						type: "text",
						text: `Session named: "${params.name}"`,
					},
				],
			};
		},
	});

	// On the first user prompt of an unnamed session, inject a one-time
	// instruction telling the agent to name the session.
	pi.on("before_agent_start", async (event, ctx) => {
		if (injected) return;
		injected = true;

		const instruction = [
			"",
			"## Session Naming",
			"",
			"Before responding to the user, use the `name_session` tool to set a short,",
			"descriptive name for this session (max 40 characters). Base the name on",
			"the user's request. Be concise — just a few words.",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + instruction,
		};
	});
}

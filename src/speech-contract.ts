// Shared by discovery, setup and context so the host does not need a per-reply
// script or any knowledge of provider credentials/protocols/audio formats.
export const speechRoutingInstructions = 'Speech is service-owned: call voice.speak with request_id and spoken text. The service handles provider credentials, TTS, streaming playback and archiving. Do not write/run ad-hoc scripts, call TTS vendors, read secrets or launch a player for ordinary speech. If the tool is unavailable, keep the text and ask to reconnect MCP; no automatic shell/CLI fallback.';

export function voiceApiContract(local: boolean) {
  return {
    transport: 'mcp', speak_tool: 'voice.speak', control_tool: local ? 'voice.control' : null,
    required_arguments: ['request_id', 'text'], optional_arguments: ['voice_id', 'speech_rate', 'loudness_rate', 'playback', 'generation_mode', 'speech_direction'],
    defaults_owner: 'service', execution_owner: 'service', provider_credentials_owner: 'service',
    synthesis_owner: 'service', archive_owner: 'service', local_playback_owner: local ? 'service' : null,
    client_audio_processing_required: false, automatic_code_or_cli_fallback: false,
    unavailable_action: 'keep_text_and_reconnect_mcp',
    replay_policy: 'same request_id never regenerates or starts playback again',
    diagnostic_cli: 'developer opt-in only; not the ordinary Agent speech path',
  } as const;
}

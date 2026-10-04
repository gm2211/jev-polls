import { fileURLToPath } from 'node:url';

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Connection configuration contains executable paths only, never account credentials. */
export function agentConnectionConfig(workspaceUrl: string) {
  const url = new URL(workspaceUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the local workspace URL: http://127.0.0.1:PORT/');
  }
  const command = process.execPath;
  const args = [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp', '--workspace-url', url.href];
  const invocation = [command, ...args].map(shellQuote).join(' ');
  return {
    workspaceUrl: url.href, command, args,
    codexCommand: `codex mcp add jev-polls -- ${invocation}`,
    claudeCommand: `claude mcp add --scope local jev-polls -- ${invocation}`,
    mcpConfig: { mcpServers: { 'jev-polls': { command, args } } },
    guidePrompt: 'Use the Jev Polls MCP tools to help prepare my research study. Start with get_guide and get_workspace. Ask one question at a time when needed. Research relevant audience dimensions with your research tools; distinguish sourced facts from synthetic assumptions and keep profiles independent of the answer being tested. Save my cohorts, personas, questions, and branching pipeline with the current workspace revision. Review the request plan before any authorized live run. Explain uncertainty and preserve disagreement in the results.',
  };
}

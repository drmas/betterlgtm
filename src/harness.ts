import { createContext, useContext } from "react";
import type { Settings } from "./settings";

/** The coding agents the app can run a review with. The backend has the matching list in `harness.rs`. */
export type HarnessId = "claude" | "codex" | "gemini" | "copilot";

export interface Fix {
  label: string;
  command?: string;
  url?: string;
}

export interface HarnessInfo {
  id: HarnessId;
  name: string;
  /** What labels call it, as in "Ask Codex". */
  short: string;
  maker: string;
  /** The command it's installed as. */
  command: string;
  /** The setting that holds a full path to it. */
  pathKey: "claudePath" | "codexPath" | "geminiPath" | "copilotPath";
  install: { unix: Fix[]; windows: Fix[] };
  signIn: Fix;
  /** Models offered in the menu, by the name the agent takes. Any other name can be typed. */
  models: [string, string][];
  /** Whether the effort setting applies. */
  effort: boolean;
  /** What the app can't do with this agent, shown where it's chosen. */
  limits?: string;
}

const NPM = (pkg: string): Fix => ({ label: "Install with npm", command: `npm install -g ${pkg}` });

export const HARNESSES: Record<HarnessId, HarnessInfo> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    short: "Claude",
    maker: "Anthropic",
    command: "claude",
    pathKey: "claudePath",
    install: {
      unix: [{ label: "Install", command: "curl -fsSL https://claude.ai/install.sh | bash" }, { label: "About Claude Code", url: "https://claude.com/claude-code" }],
      windows: [{ label: "Install from PowerShell", command: "irm https://claude.ai/install.ps1 | iex" }, { label: "About Claude Code", url: "https://claude.com/claude-code" }],
    },
    signIn: { label: "Sign in", command: "claude auth login" },
    models: [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"]],
    effort: true,
  },
  codex: {
    id: "codex",
    name: "Codex",
    short: "Codex",
    maker: "OpenAI",
    command: "codex",
    pathKey: "codexPath",
    install: {
      unix: [NPM("@openai/codex"), { label: "About Codex", url: "https://developers.openai.com/codex/cli" }],
      windows: [NPM("@openai/codex"), { label: "About Codex", url: "https://developers.openai.com/codex/cli" }],
    },
    signIn: { label: "Sign in", command: "codex login" },
    models: [],
    effort: true,
    limits: "Runs in Codex's read-only sandbox, and may search the web. The spending limit for automatic analyses doesn't apply, and cost isn't reported.",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    short: "Gemini",
    maker: "Google",
    command: "gemini",
    pathKey: "geminiPath",
    install: {
      unix: [NPM("@google/gemini-cli"), { label: "About Gemini CLI", url: "https://geminicli.com" }],
      windows: [NPM("@google/gemini-cli"), { label: "About Gemini CLI", url: "https://geminicli.com" }],
    },
    signIn: { label: "Run it once in a terminal and choose how to sign in", command: "gemini" },
    models: [],
    effort: false,
    limits: "Experimental: runs in Gemini CLI's read-only plan mode. The effort setting and the spending limit don't apply, and cost isn't reported.",
  },
  copilot: {
    id: "copilot",
    name: "Copilot CLI",
    short: "Copilot",
    maker: "GitHub",
    command: "copilot",
    pathKey: "copilotPath",
    install: {
      unix: [NPM("@github/copilot"), { label: "About Copilot CLI", url: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli" }],
      windows: [NPM("@github/copilot"), { label: "About Copilot CLI", url: "https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli" }],
    },
    signIn: { label: "Sign in", command: "copilot login" },
    models: [],
    effort: true,
    limits: "Experimental: can read files and run read-only commands, and nothing else. The spending limit doesn't apply, and cost isn't reported.",
  },
};

export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

/** The chosen agent; settings from before there was a choice mean Claude Code. */
export const harnessOf = (s: Pick<Settings, "harness">): HarnessInfo => HARNESSES[s.harness] ?? HARNESSES.claude;

/** The chosen agent for the components under the main window, so their labels can name it. */
export const AgentContext = createContext<HarnessInfo>(HARNESSES.claude);
export const useAgent = () => useContext(AgentContext);

/** The agent that double-checks, when it isn't the one running the review. Choosing the main agent counts as "Same agent". */
export function crossAgentOf(verifyWith: HarnessId | "same", main: HarnessId): HarnessId | undefined {
  return verifyWith !== "same" && verifyWith !== main ? verifyWith : undefined;
}

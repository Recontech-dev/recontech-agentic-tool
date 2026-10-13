// Find and mask secrets, so they are never stored in the brain or committed by mistake.

// Formats that are specific enough to trust anywhere, including in source code.
export const TOKEN_PATTERNS = [
  "sk-[A-Za-z0-9_-]{20,}", // Anthropic, OpenAI, OpenRouter
  "gsk_[A-Za-z0-9]{20,}", // Groq
  "csk-[A-Za-z0-9]{20,}", // Cerebras
  "AIza[0-9A-Za-z_-]{35}", // Google
  "gh[pousr]_[A-Za-z0-9]{36,}", // GitHub
  "github_pat_[A-Za-z0-9_]{20,}",
  "AKIA[0-9A-Z]{16}", // AWS
  "xox[baprs]-[A-Za-z0-9-]{10,}", // Slack
  "hf_[A-Za-z0-9]{30,}", // Hugging Face
  "npm_[A-Za-z0-9]{36}", // npm
  "[sr]k_live_[A-Za-z0-9]{20,}", // Stripe
  "glpat-[A-Za-z0-9_-]{20,}", // GitLab
  "ya29\\.[A-Za-z0-9_-]{20,}", // Google OAuth
  "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}", // JWT
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
];

const tokens = () => new RegExp(TOKEN_PATTERNS.join("|"), "g");
// "password = hunter2" style assignments. Too noisy for scanning code, fine for notes.
const ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|token)(\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi;

export function findTokens(text: string): string[] {
  return text.match(tokens()) ?? [];
}

// The password in an address such as postgres://user:password@host.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;

export function redact(text: string): string {
  return text.replace(tokens(), "[secret removed]").replace(ASSIGNMENT, "$1$2[secret removed]").replace(URL_PASSWORD, "$1[secret removed]@");
}

export type ManualInterventionReason = "login" | "checkpoint" | "human_verification";

export function classifyManualIntervention(
  pageUrl: string,
  visibleText: string,
  hasCaptchaFrame: boolean,
  hasLoginForm = false,
): ManualInterventionReason | undefined {
  const url = new URL(pageUrl);
  const text = visibleText.toLowerCase();

  if (url.pathname.startsWith("/checkpoint/") || url.pathname.startsWith("/recover/")) {
    return "checkpoint";
  }
  if (
    hasCaptchaFrame ||
    /confirm (?:that )?you(?:'|’)re human|verify (?:that )?you(?:'|’)re human|security check|captcha/.test(
      text,
    )
  ) {
    return "human_verification";
  }
  if (url.pathname.startsWith("/login/") || hasLoginForm) return "login";
  return undefined;
}

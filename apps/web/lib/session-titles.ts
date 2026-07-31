const PREFIX = "pca-session-title:";

export function saveSessionTitle(runId: string, prompt: string): void {
  try {
    localStorage.setItem(`${PREFIX}${runId}`, prompt.trim());
  } catch {
    // History keeps its repository fallback when storage is unavailable.
  }
}

export function loadSessionTitles(runIds: string[]): Record<string, string> {
  const titles: Record<string, string> = {};
  try {
    for (const id of runIds) {
      const title = localStorage.getItem(`${PREFIX}${id}`);
      if (title) titles[id] = title;
    }
  } catch {
    // Browser privacy settings may make localStorage unavailable.
  }
  return titles;
}

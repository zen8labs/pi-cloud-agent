import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackagePath } from "./paths";

export interface DiscoveredSkill {
  name: string;
  description: string;
  body: string;
}

/** Discover each skill directory SKILL.md under the package skills folder. */
export function discoverSkills(packageRoot: string, skillsDir = "skills/"): DiscoveredSkill[] {
  const root = resolvePackagePath(packageRoot, skillsDir);
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }

  const skills: DiscoveredSkill[] = [];
  for (const dirName of entries) {
    const skillPath = join(root, dirName, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(raw, dirName);
    if (parsed.body.trim()) skills.push(parsed);
  }
  return skills;
}

function parseSkillMarkdown(raw: string, fallbackName: string): DiscoveredSkill {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { name: fallbackName, description: "", body: raw.trim() };
  }
  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const name = frontmatterField(frontmatter, "name") ?? fallbackName;
  const description = frontmatterField(frontmatter, "description") ?? "";
  return { name, description, body };
}

function frontmatterField(frontmatter: string, key: string): string | undefined {
  const line = frontmatter.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  if (!line) return undefined;
  return (
    line
      .slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, "") || undefined
  );
}

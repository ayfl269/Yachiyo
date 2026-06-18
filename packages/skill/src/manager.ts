import type { SqliteSkillStore } from "@yachiyo/config/sqlite-config-extras-store.js";
import { readdir, readFile, stat, mkdir } from "fs/promises";
import { join, extname, dirname } from "path";
import { existsSync } from "fs";
import type { SkillInfo } from "@yachiyo/common/skill-types.js";

export type { SkillInfo };


interface SkillManifest {
  name: string;
  description?: string;
  active?: boolean;
  readonly?: boolean;
}

interface ParsedSkillMd {
  name: string;
  description: string;
  active?: boolean;
  readonly?: boolean;
}

const SKILL_MD_FILENAME = "skill.md";
const SKILLS_MD_FILENAME = "skills.md";

export class SkillManager {
  skillsRoot: string;
  pluginsRoot: string;
  private skills: Map<string, SkillInfo> = new Map();
  private sqliteStore?: SqliteSkillStore;

  constructor(skillsRoot: string = "", pluginsRoot: string = "") {
    this.skillsRoot = skillsRoot;
    this.pluginsRoot = pluginsRoot;
  }

  setSqliteStore(store: SqliteSkillStore): void {
    this.sqliteStore = store;
  }

  async restoreFromStore(): Promise<void> {
    if (!this.sqliteStore) return;
    const saved = this.sqliteStore.getAllSkills();
    for (const skill of saved) {
      this.skills.set(skill.name, skill);
    }
  }

  async scanAndLoadSkills(): Promise<void> {
    await this.scanRootSkillsMd();
    await this.scanSkillsDirectory();
    await this.scanPluginsDirectory();
    console.log(`[SkillManager] Scan complete. Total skills: ${this.skills.size}`);
  }

  private async scanRootSkillsMd(): Promise<void> {
    const candidates = [this.skillsRoot, dirname(this.skillsRoot)];
    for (const base of candidates) {
      if (!base || !existsSync(base)) continue;
      const mdPath = join(base, SKILLS_MD_FILENAME);
      if (!existsSync(mdPath)) continue;

      try {
        const content = await readFile(mdPath, "utf-8");
        const parsed = this.parseSkillsMdContent(content);
        for (const skill of parsed) {
          const existing = this.skills.get(skill.name);
          const info: SkillInfo = {
            name: skill.name,
            description: skill.description,
            path: mdPath,
            active: existing?.active ?? (skill.active ?? true),
            sourceType: "local",
            sourceLabel: "Local Skills",
            localExists: true,
            sandboxExists: false,
            pluginName: "",
            readonly: skill.readonly ?? false,
          };
          this.skills.set(info.name, info);
          this.sqliteStore?.saveSkill(info);
        }
        console.log(`[SkillManager] Loaded ${parsed.length} skills from ${mdPath}`);
        return;
      } catch (e) {
        console.warn(`[SkillManager] Failed to parse ${mdPath}: ${e}`);
      }
    }
  }

  private parseSkillsMdContent(content: string): ParsedSkillMd[] {
    const results: ParsedSkillMd[] = [];
    const lines = content.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      if (line.startsWith("---") && i === 0) {
        const endIdx = lines.indexOf("---", 1);
        if (endIdx > 0) {
          const frontmatter = lines.slice(1, endIdx).join("\n");
          const bodyStart = endIdx + 1;
          const body = lines.slice(bodyStart).join("\n").trim();

          const fm = this.parseYamlFrontmatter(frontmatter);

          if (fm.skills && Array.isArray(fm.skills)) {
            for (const s of fm.skills) {
              if (typeof s === "string") {
                const parts = s.split(":").map(p => p.trim());
                results.push({ name: parts[0], description: parts.slice(1).join(":").trim() || "" });
              } else if (typeof s === "object" && s !== null) {
                results.push({
                  name: String(s.name ?? ""),
                  description: String(s.description ?? ""),
                  active: s.active as boolean | undefined,
                  readonly: s.readonly as boolean | undefined,
                });
              }
            }
          } else if (fm.name) {
            results.push({
              name: String(fm.name),
              description: fm.description ? String(fm.description) : body.split("\n")[0]?.replace(/^#\s*/, "") || "",
              active: fm.active as boolean | undefined,
              readonly: fm.readonly as boolean | undefined,
            });
          }
          break;
        }
      }

      if (line.startsWith("# ")) {
        const name = line.replace(/^#+\s*/, "").trim();
        const descLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("# ") && lines[i].trim() !== "") {
          descLines.push(lines[i].trim());
          i++;
        }
        results.push({
          name,
          description: descLines.join(" ").trim(),
        });
        continue;
      }

      if (line.startsWith("- ") || line.startsWith("* ")) {
        const item = line.replace(/^[-*]\s+/, "");
        const colonIdx = item.indexOf(":");
        if (colonIdx > 0) {
          results.push({
            name: item.substring(0, colonIdx).trim(),
            description: item.substring(colonIdx + 1).trim(),
          });
        } else {
          results.push({ name: item.trim(), description: "" });
        }
      }

      i++;
    }

    return results;
  }

  private parseYamlFrontmatter(yamlText: string): Record<string, string | boolean | number | any[]> {
    const result: Record<string, string | boolean | number | any[]> = {};
    for (const rawLine of yamlText.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const key = line.substring(0, colonIdx).trim();
      let value: string | boolean | number | any[] = line.substring(colonIdx + 1).trim();

      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
      else if (value.startsWith("[") && value.endsWith("[")) {
        try { value = JSON.parse(value.replace(/'/g, '"')); } catch { /* keep as string */ }
      }

      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (existing !== undefined) {
        result[key] = [existing, value];
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private async scanSkillsDirectory(): Promise<void> {
    if (!this.skillsRoot || !existsSync(this.skillsRoot)) return;

    try {
      const entries = await readdir(this.skillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === SKILLS_MD_FILENAME) continue;
        if (!entry.isDirectory()) continue;
        const skillDir = join(this.skillsRoot, entry.name);
        await this.loadSkillFromDirectory(skillDir, entry.name, "local", "Local Skills");
      }
    } catch (e) {
      console.warn(`[SkillManager] Error scanning skills directory: ${e}`);
    }
  }

  private async scanPluginsDirectory(): Promise<void> {
    if (!this.pluginsRoot || !existsSync(this.pluginsRoot)) return;

    try {
      const entries = await readdir(this.pluginsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = join(this.pluginsRoot, entry.name);
        const skillsDir = join(pluginDir, "skills");
        if (!existsSync(skillsDir)) continue;

        const skillEntries = await readdir(skillsDir, { withFileTypes: true });
        for (const skillEntry of skillEntries) {
          if (skillEntry.name === SKILLS_MD_FILENAME) continue;
          if (!skillEntry.isDirectory()) continue;
          const skillDir = join(skillsDir, skillEntry.name);
          await this.loadSkillFromDirectory(skillDir, skillEntry.name, "plugin", entry.name);
        }
      }
    } catch (e) {
      console.warn(`[SkillManager] Error scanning plugins directory: ${e}`);
    }
  }

  private async loadSkillFromDirectory(
    dirPath: string,
    dirName: string,
    sourceType: string,
    sourceLabel: string
  ): Promise<void> {
    const mdPath = join(dirPath, SKILL_MD_FILENAME);
    const manifestPath = join(dirPath, "manifest.json");

    let manifest: SkillManifest = { name: dirName, description: "", active: true };

    if (existsSync(mdPath)) {
      try {
        const content = await readFile(mdPath, "utf-8");
        const parsed = this.parseSkillMdContent(content, dirName);
        manifest = { ...manifest, ...parsed };
      } catch (e) {
        console.warn(`[SkillManager] Failed to parse ${SKILL_MD_FILENAME} for skill "${dirName}": ${e}`);
      }
    } else if (existsSync(manifestPath)) {
      try {
        const content = await readFile(manifestPath, "utf-8");
        const parsed = JSON.parse(content);
        manifest = { ...manifest, ...parsed };
      } catch (e) {
        console.warn(`[SkillManager] Failed to parse manifest.json for skill "${dirName}": ${e}`);
      }
    }

    const existing = this.skills.get(manifest.name);
    const skillInfo: SkillInfo = {
      name: manifest.name,
      description: manifest.description ?? "",
      path: dirPath,
      active: existing?.active ?? (manifest.active ?? true),
      sourceType,
      sourceLabel,
      localExists: sourceType === "local",
      sandboxExists: sourceType === "plugin",
      pluginName: sourceType === "plugin" ? sourceLabel : "",
      readonly: manifest.readonly ?? false,
    };

    this.skills.set(skillInfo.name, skillInfo);
    this.sqliteStore?.saveSkill(skillInfo);
  }

  private parseSkillMdContent(content: string, fallbackName: string): Partial<SkillManifest> {
    const lines = content.split("\n");
    let hasFrontmatter = false;
    let frontmatterEnd = -1;

    if (lines[0]?.trim() === "---") {
      const endIdx = lines.indexOf("---", 1);
      if (endIdx > 0) {
        hasFrontmatter = true;
        frontmatterEnd = endIdx;
      }
    }

    const result: Partial<SkillManifest> = {};

    if (hasFrontmatter) {
      const yamlText = lines.slice(1, frontmatterEnd).join("\n");
      const fm = this.parseYamlFrontmatter(yamlText);
      if (fm.name) result.name = String(fm.name);
      if (fm.description) result.description = String(fm.description);
      if (typeof fm.active === "boolean") result.active = fm.active;
      if (typeof fm.readonly === "boolean") result.readonly = fm.readonly;

      const bodyLines = lines.slice(frontmatterEnd + 1).map(l => l.trim()).filter(l => l);
      if (!result.description && bodyLines.length > 0) {
        const firstNonHeading = bodyLines.find(l => !l.startsWith("#"));
        if (firstNonHeading) result.description = firstNonHeading.replace(/^#+\s*/, "");
      }
    } else {
      const firstLine = lines.find(l => l.trim());
      if (firstLine?.startsWith("# ")) {
        result.name = firstLine.replace(/^#+\s*/, "").trim();
      }
      const descLines: string[] = [];
      let foundHeading = false;
      for (const l of lines) {
        const trimmed = l.trim();
        if (trimmed.startsWith("# ")) {
          foundHeading = true;
          continue;
        }
        if (foundHeading && trimmed && !trimmed.startsWith("#")) {
          descLines.push(trimmed);
        }
      }
      if (descLines.length > 0) {
        result.description = descLines.join(" ");
      }
    }

    if (!result.name) result.name = fallbackName;
    return result;
  }

  listSkills(options?: {
    activeOnly?: boolean;
    runtime?: string;
    showSandboxPath?: boolean;
  }): SkillInfo[] {
    let results = [...this.skills.values()];
    if (options?.activeOnly) {
      results = results.filter(s => s.active);
    }
    return results;
  }

  setSkillActive(name: string, active: boolean): void {
    const skill = this.skills.get(name);
    if (skill) {
      skill.active = active;
      this.sqliteStore?.setSkillActive(name, active);
    }
  }

  deleteSkill(name: string): void {
    this.skills.delete(name);
    this.sqliteStore?.deleteSkill(name);
  }

  registerSkill(skill: SkillInfo): void {
    this.skills.set(skill.name, skill);
    this.sqliteStore?.saveSkill(skill);
  }
}

export function buildSkillsPrompt(skills: SkillInfo[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(s => `- ${s.name}: ${s.description}`);
  return `Available skills:\n${lines.join("\n")}`;
}

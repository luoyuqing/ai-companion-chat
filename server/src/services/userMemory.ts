import { promises as fs } from "fs";
import path from "path";

const WORKSPACE_ROOT =
  path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
const DATA_DIR = path.join(WORKSPACE_ROOT, "server", "src", "data", "user-memories");

// 长期记忆（用户与某数字人的关系/记忆资料）——后端唯一真源，跨浏览器/TG 一致。
export interface UserMemory {
  displayName?: string;
  preferredName?: string;
  preferences?: string;
  importantFacts?: string;
  boundaries?: string;
  relationshipNotes?: string;
  updatedAt?: string;
}

const EMPTY: UserMemory = {
  displayName: "",
  preferredName: "",
  preferences: "",
  importantFacts: "",
  boundaries: "",
  relationshipNotes: "",
  updatedAt: ""
};

function safeId(id: string): string {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "default";
}

function filePath(characterId: string): string {
  return path.join(DATA_DIR, `${safeId(characterId)}.json`);
}

function normalize(raw: unknown): UserMemory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY };
  const v = raw as Partial<UserMemory>;
  return {
    displayName: String(v.displayName || "").slice(0, 80),
    preferredName: String(v.preferredName || "").slice(0, 80),
    preferences: String(v.preferences || "").slice(0, 360),
    importantFacts: String(v.importantFacts || "").slice(0, 360),
    boundaries: String(v.boundaries || "").slice(0, 360),
    relationshipNotes: String(v.relationshipNotes || "").slice(0, 360),
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : ""
  };
}

export async function getUserMemory(characterId: string): Promise<UserMemory> {
  try {
    const raw = await fs.readFile(filePath(characterId), "utf8");
    return normalize(JSON.parse(raw));
  } catch {
    return { ...EMPTY };
  }
}

export async function saveUserMemory(characterId: string, memory: UserMemory): Promise<UserMemory> {
  const normalized = normalize({ ...memory, updatedAt: new Date().toISOString() });
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(filePath(characterId), JSON.stringify(normalized, null, 2), "utf8");
  } catch (err) {
    console.error(`保存用户记忆失败 (${characterId}):`, err);
  }
  return normalized;
}

// 清除某数字人的长期记忆文件（后端唯一真源）。不存在时也视���成功。
export async function deleteUserMemory(characterId: string): Promise<void> {
  try {
    await fs.rm(filePath(characterId), { force: true });
  } catch (err) {
    console.error(`删除用户记忆失败 (${characterId}):`, err);
  }
}


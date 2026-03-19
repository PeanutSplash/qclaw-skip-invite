import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, basename, extname } from "node:path";
import { createInterface } from "node:readline";

const isMac = platform() === "darwin";
const isWin = platform() === "win32";

if (!isMac && !isWin) {
  console.error("错误：仅支持 macOS 和 Windows 系统。");
  process.exit(1);
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function findAppPath(): Promise<string> {
  if (isMac) return "/Applications/QClaw.app";
  const asarRelPath = "resources/app.asar";
  const candidates = [
    join(process.env.LOCALAPPDATA || "", "Programs/QClaw"),
    "C:\\Program Files\\QClaw",
    "C:\\Program Files (x86)\\QClaw",
  ];
  for (const p of candidates) {
    if (existsSync(join(p, asarRelPath))) return p;
  }
  console.log("未在默认路径找到 QClaw，请手动指定。");
  const input = await prompt("请输入 QClaw 安装路径: ");
  if (input && existsSync(join(input, asarRelPath))) return input;
  console.error(`错误：在 ${join(input || "<空>", asarRelPath)} 未找到 QClaw`);
  process.exit(1);
}

const nodeVersion = parseInt(process.versions.node.split(".")[0]);
if (nodeVersion < 22) {
  console.error(`错误：需要 Node >= 22（当前版本: ${process.versions.node}）`);
  process.exit(1);
}

function patchApiUrl(content: string, customUrl: string): string {
  if (!customUrl) return content;
  const baseUrl = customUrl.replace(/\/+$/, "");
  return content
    .replace(/https?:\/\/api\.deepseek\.com\/?/g, baseUrl + "/")
    .replace(/https?:\/\/api\.deepseek\.com/g, baseUrl);
}

function patchBrandName(content: string, customName: string): string {
  if (!customName) return content;
  return content
    .replace(/\bDeepSeek\b/g, customName)
    .replace(/\bdeepseek\b/g, customName.toLowerCase())
    .replace(/\bDEEPSEEK\b/g, customName.toUpperCase())
    .replace(/deepseek(?=\.com|\/|:)/gi, customName.toLowerCase().replace(/\s+/g, ''));
}

function getAllFiles(dir: string, fileList: string[] = []): string[] {
  const files = readdirSync(dir);
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      getAllFiles(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const textExts = ['.js', '.json', '.html', '.css', '.map', '.md', '.txt', '.xml', '.yaml', '.yml'];
  if (textExts.includes(ext)) return true;
  try {
    const buffer = readFileSync(filePath, { encoding: null }).slice(0, 512);
    const nullBytes = buffer.filter(b => b === 0).length;
    return nullBytes < 5;
  } catch {
    return false;
  }
}

(async () => {
  const APP_PATH = await findAppPath();
  const ASAR_PATH = isMac
    ? join(APP_PATH, "Contents/Resources/app.asar")
    : join(APP_PATH, "resources/app.asar");
  const ELECTRON_BIN = isMac
    ? join(APP_PATH, "Contents/Frameworks/Electron Framework.framework/Electron Framework")
    : join(APP_PATH, "QClaw.exe");

  const customApiUrl = await prompt("请输入自定义 API URL（留空跳过）: ");
  const customBrandName = await prompt("请输入自定义品牌名称替换 'DeepSeek'（留空跳过）: ");

  if (!customApiUrl && !customBrandName) {
    console.log("⚠️  未输入任何替换内容，退出。");
    process.exit(0);
  }

  let wasRunning = false;
  try {
    if (isMac) {
      execSync("pgrep -f QClaw", { stdio: "ignore" });
      wasRunning = true;
      console.log("==> 检测到 QClaw 正在运行，正在关闭...");
      try { execSync("pkill -f QClaw"); } catch {}
      execSync("sleep 1");
    } else {
      execSync("tasklist /FI \"IMAGENAME eq QClaw.exe\" | findstr QClaw.exe", { stdio: "ignore" });
      wasRunning = true;
      console.log("==> 检测到 QClaw 正在运行，正在关闭...");
      for (let i = 0; i < 3; i++) {
        try { execSync("taskkill /F /IM QClaw.exe", { stdio: "ignore" }); } catch {}
        try {
          execSync("tasklist /FI \"IMAGENAME eq QClaw.exe\" | findstr QClaw.exe", { stdio: "ignore" });
          execSync("powershell -Command \"Start-Sleep -Seconds 1\"");
        } catch { break; }
      }
      execSync("powershell -Command \"Start-Sleep -Seconds 1\"");
    }
  } catch {}

  const workDir = mkdtempSync(join(tmpdir(), "qclaw-patch-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(1); });

  try {
    console.log("==> 正在解包应用资源...");
    execSync(`npx --yes @electron/asar extract "${ASAR_PATH}" "${join(workDir, "app")}"`, { stdio: "inherit" });

    const appDir = join(workDir, "app");
    const assetsDir = join(appDir, "out/renderer/assets");
    
    // 1. 邀请码补丁
    if (existsSync(assetsDir)) {
      const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith(".js"));
      for (const file of jsFiles) {
        const filePath = join(assetsDir, file);
        const content = readFileSync(filePath, "utf8");
        if (content.includes("inviteCodeVerified")) {
          console.log(`==> 定位到邀请码文件: ${basename(filePath)}`);
          let code = content;
          const retMatch = code.match(/inviteCodeVerified:(\w+)/);
          if (retMatch) {
            const varName = retMatch[1];
            const retPos = code.indexOf(retMatch[0]);
            const refPattern = new RegExp(`((?<![a-zA-Z0-9_$])${varName}=\\w+\\()(!0|!1)(\\))`, "g");
            let lastMatch: RegExpExecArray | null = null;
            let matchOffset = 0;
            for (let range = 10000; range <= retPos; range *= 2) {
              const searchStart = Math.max(0, retPos - range);
              const chunk = code.slice(searchStart, retPos);
              refPattern.lastIndex = 0;
              const matches = [...chunk.matchAll(refPattern)];
              if (matches.length > 0) {
                lastMatch = matches[matches.length - 1];
                matchOffset = searchStart + lastMatch.index!;
                break;
              }
              if (searchStart === 0) break;
            }
            if (lastMatch) {
              if (lastMatch[2] === "!0") {
                console.log("==> 邀请码验证已跳过");
              } else {
                const patched = lastMatch[1] + "!0" + lastMatch[3];
                code = code.slice(0, matchOffset) + patched + code.slice(matchOffset + lastMatch[0].length);
                writeFileSync(filePath, code);
                console.log("==> 成功跳过邀请码验证");
              }
            }
          }
          break;
        }
      }
    }

    // 2. 全量扫描替换
    console.log("==> 正在扫描所有资源文件进行替换...");
    const allFiles = getAllFiles(appDir);
    let modifiedCount = 0;
    let skipCount = 0;

    for (const filePath of allFiles) {
      if (!isTextFile(filePath)) {
        skipCount++;
        continue;
      }
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        skipCount++;
        continue;
      }
      const original = content;
      if (customApiUrl) content = patchApiUrl(content, customApiUrl);
      if (customBrandName) content = patchBrandName(content, customBrandName);
      if (content !== original) {
        writeFileSync(filePath, content, "utf8");
        console.log(`  ✓ ${filePath.replace(appDir, "")}`);
        modifiedCount++;
      }
    }

    console.log(`==> 处理完成：修改 ${modifiedCount} 个文件，跳过 ${skipCount} 个二进制文件`);

    console.log("==> 正在重新打包...");
    execSync(`npx --yes @electron/asar pack "${appDir}" "${join(workDir, "app-patched.asar")}"`, { stdio: "inherit" });

    console.log("==> 正在替换应用资源...");
    cpSync(join(workDir, "app-patched.asar"), ASAR_PATH);

    const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    const FUSE_ASAR_INTEGRITY_INDEX = 4;
    const bin = Buffer.from(readFileSync(ELECTRON_BIN));
    const sentinelPos = bin.indexOf(FUSE_SENTINEL);
    if (sentinelPos === -1) {
      console.error("错误：未找到完整性校验标记，可能 QClaw 版本不兼容");
      process.exit(1);
    }
    const fuseOffset = sentinelPos + FUSE_SENTINEL.length + 2 + FUSE_ASAR_INTEGRITY_INDEX;
    if (bin[fuseOffset] === 0x31) {
      bin[fuseOffset] = 0x30;
      writeFileSync(ELECTRON_BIN, bin);
      console.log("==> 已关闭完整性校验");
    }

    if (isMac) {
      console.log("==> 正在重新签名...");
      execSync(`codesign --remove-signature "${APP_PATH}"`, { stdio: "inherit" });
      execSync(`codesign --force --deep --sign - "${APP_PATH}"`, { stdio: "inherit" });
    }

    console.log("\n✅ 补丁完成！请重新打开 QClaw 即可使用。");
    if (customApiUrl) console.log(`   🔗 API: ${customApiUrl}`);
    if (customBrandName) console.log(`   🏷️  品牌：DeepSeek → ${customBrandName}`);

    if (wasRunning) {
      console.log("==> 正在重新启动 QClaw...");
      if (isMac) execSync(`open "${APP_PATH}"`);
      else execSync(`start "" "${join(APP_PATH, "QClaw.exe")}"`, { stdio: "ignore" });
    }
  } catch (err: any) {
    if (isWin && (err?.code === "EPERM" || err?.code === "EBUSY")) {
      console.error("\n❌ 错误：权限不足，无法写入 QClaw 安装目录。");
      console.error("请以管理员身份运行终端后重试。");
    } else if (isWin && err?.code === "EIO") {
      console.error("\n❌ 错误：QClaw 文件被占用，无法写入。");
      console.error("请先彻底关闭 QClaw（检查系统托盘），然后重试。");
    } else {
      console.error(err);
    }
    process.exit(1);
  }
})();

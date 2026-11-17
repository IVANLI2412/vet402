// ============================================================
// ERC-8004 段階 D 用の書き手鍵を ~/.vet402/erc8004-writer.json に作る。
// 既にあれば上書きしない。秘密鍵は表示しない（アドレスだけ）。
// ============================================================
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const DEFAULT_PATH = path.join(os.homedir(), ".vet402", "erc8004-writer.json");

function main() {
  const out = process.env.ERC8004_WRITER_KEY_FILE?.trim() || DEFAULT_PATH;
  if (fs.existsSync(out)) {
    try {
      const existing = JSON.parse(fs.readFileSync(out, "utf8")) as { address?: string };
      if (existing.address) {
        console.log(existing.address);
        return;
      }
    } catch {
      console.error("existing_key_unreadable");
      process.exit(1);
    }
    console.error("key_file_exists");
    process.exit(1);
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  const payload = {
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
    purpose: "erc8004_reputation_writer",
  };
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  console.log(account.address);
}

main();
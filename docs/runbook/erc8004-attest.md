# ERC-8004 週次 Attest（段階 D）手順

## 前提

- W・B・C が本番に入り、`state.erc8004` に `agent_wallet` 一致が載っていること。
- 書き手鍵は購入用 payer と別アドレス（`npm run erc8004:writer-keygen` は vet402.com セッションが実行）。
- 本番送信は `ERC8004_ATTEST_ENABLED=1` とオーナー承認後のみ。

## 毎週（UTC 月曜以降）

1. 対象週を決める（例: 直前の ISO 週 `YYYY-Www`）。
2. 空実行:
   ```bash
   npm run erc8004:attest -- --week YYYY-Www --skip-rpc
   ```
   本番 state だけ見る場合は `VET402_STATE_URL` の既定（https://vet402.com/api/v1/observatory/state）のまま。DB 行が要る詳細計画は `DATABASE_URL` を付けた環境でのみ。
3. 出力の `targetAgents`・`planned`・各 agent の率と `eth_call` を確認。`~/.vet402/erc8004-attest/YYYY-Www.json` に既に載っている agent はスキップ（pending も含む）。
4. RPC で revert しないことを確認する週は `--skip-rpc` を外し、`ERC8004_WRITER_ADDRESS` に将来の書き手アドレスを置く（鍵ファイルは読まない）。
5. 送信（承認後のみ）:
   ```bash
   ERC8004_ATTEST_ENABLED=1 npm run erc8004:attest -- --week YYYY-Www --send
   ```
   書き手に Base ETH が足りること。1 回あたり最大 200 agent・合計ガス 0.0005 ETH で打ち切る。

## 記録

- 台帳は `~/.vet402/erc8004-attest/YYYY-Www.json`（worktree の外に1つ・`ERC8004_ATTEST_LEDGER_DIR` で変えられる）。送る前に `pending`、受領後に `written`／`reverted` と tx を書く。
- `pending` のまま止まった agent は、basescan で書き手の tx を見てから台帳を直す（見ずに消すと二度書きになる）。
- revert が1件出たら走りを止める。原因を見てから次の走り。
- 異議は売り手がチェーン上で `appendResponse`（vet402 は受理するが内容は独自に検証しない）。
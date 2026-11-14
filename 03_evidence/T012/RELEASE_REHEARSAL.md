# RELEASE_REHEARSAL.md — P023 T012 发布预演（非冻结）

- HEAD commit: `495890da26b2a283e5f7b0e474035afce5150e16`
- 生成时间 (UTC)：2026-11-13T15:47:03.670Z
- 说明：本预演复现 T014 的打包流程（git archive → dist zip → SHA256SUMS → unzip -t → sha256sum -c → 干净目录重建 + 烟囱审计），但产物在 `03_evidence/T012/rehearsal/`，不写 `release/`；T014 将从冻结 commit 重新完整执行。
- 唯一偏离冷检出的地方：干净目录用 symlink 链接本仓库的 `node_modules` 代替 `npm ci`（本机不联网，不可用也不需要网络）；构建与审计均在该目录内完成。

## 产物

| 文件 | 字节 | sha256 |
|---|---:|---|
| rehearsal/source.zip | 1342913 | `bce9c763d866d9917e2198845ed0b9bad6c9769420fe67c39300e78e76739b93` |
| rehearsal/dist.zip | 87127 | `4ed1c1454d52248eecc3bc9cc500aa768a3b9493c48b08b0b9f8b3cf7bdf40db` |

## 检查

- [PASS] tracked tree clean at rehearsal commit
- [PASS] git archive HEAD → source.zip
- [PASS] source.zip non-empty — 1342913 bytes
- [PASS] npm run build
- [PASS] zip -r dist.zip dist
- [PASS] dist.zip non-empty — 87127 bytes
- [PASS] unzip -t source.zip — No errors detected in compressed data of /tmp/skillscope-rehearsal-t37yHe/source.zip. 
- [PASS] unzip -t dist.zip — No errors detected in compressed data of /tmp/skillscope-rehearsal-t37yHe/dist.zip. 
- [PASS] sha256sum -c SHA256SUMS.txt — source.zip: OK
dist.zip: OK
- [PASS] extract source.zip to clean dir
- [PASS] clean tree has package.json + src + tests
- [PASS] all 23 .gitkeep directories present in clean tree
- [PASS] clean-room npm run build (linked node_modules)
- [PASS] clean-room smoke audit exits 1 (codex-fail) — exit 1; 
- [PASS] repo smoke audit exits 1 (codex-fail) — exit 1
- [PASS] clean-room audit_sha256 == repo audit_sha256 (path-independent redaction) — clean 948f94149b3a451f25c93ff2587e3f009e79ca4be0f960a964fbd95b314f9fce vs repo 948f94149b3a451f25c93ff2587e3f009e79ca4be0f960a964fbd95b314f9fce

## 结论：PASS

- clean-room audit_sha256：`948f94149b3a451f25c93ff2587e3f009e79ca4be0f960a964fbd95b314f9fce`
- repo audit_sha256：`948f94149b3a451f25c93ff2587e3f009e79ca4be0f960a964fbd95b314f9fce`
- 全部检查通过。

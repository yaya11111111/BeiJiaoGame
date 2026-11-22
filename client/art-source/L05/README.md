# L05 备用素材（不参与构建）

这些图原本放在 `client/assets/resources/`，**没有接入 `level.05.json` 的流程**，
但仍然会被整个 `resources` 分包打进小游戏。为了减小分包，2026-10-28 移到
`client/art-source/`（`assets/` 之外，Cocos 不会导入）。

`.meta` 一起保留，将来要移回去时 uuid 不变，不会让别的机器重新生成一套。

## 未接入的原因

- `L05_A_scene_cabinet_open`、`L05_display_cabinet_detail`：漫画卡 05 尚未制作，
  开发卡明确暂不接入展示柜与领卡步骤。
- `L05_pack_A/B/C`：一个热点只能挂一张特写；只挂 B 套餐牌会暗示答案，
  所以套餐规则改用文字。以后若要做「点哪块牌看哪张」，可拆成三个热点。
- `L05_receipt_fail1/2`：目前答错只有文字软拒绝，没有「弹失败特写」的机制。
- `L05_ticket_front`：餐券领取口只挂了一张（用了背面）；正面内容写在文字里。
- `L05_ticket_back_after`、`L05_ticket_verified`：没有道具状态图机制。
- `L05_checkin_terminal_detail`、`L05_A_table07_detail`、`L05_drink_subsidy_coupon`：
  热点区域和已有热点重叠，一个位置只挂了一张特写。
- `L05_ordering_kiosk_detail1/2`：图上是四行填空/套餐选择，和实际六项表单对不上，
  弹出来会误导。
- `L05_old_flow_sheet`：开发卡注明当前谜题不要求它参与答案。

## 要移回去时

```bash
git mv client/art-source/L05/bg/<文件>.jpg client/assets/resources/bg/
git mv client/art-source/L05/bg/<文件>.jpg.meta client/assets/resources/bg/
# details 同理
```

移回后在 `level.05.json` 里加上对应的 `assetKey` / `detailKey` / `iconKey`，
再在 Cocos 里重新构建一次。

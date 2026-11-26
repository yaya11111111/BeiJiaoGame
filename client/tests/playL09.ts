import { expect } from 'vitest';
import type { LevelRuntime } from '../assets/scripts/level/LevelRuntime';
export async function playL09(A: LevelRuntime, B: LevelRuntime = A, afterStep: () => Promise<void> = async () => {}) {
  const run = async (view: 'A' | 'B', kind: 'click' | 'go' | 'form' | 'item' | 'choice', id: string, value?: any) => {
    const r = view === 'A' ? A : B; if (A === B) r.switchView(view);
    const result = kind === 'go' ? (r.getCurrentScene() === id || r.goToScene(id)) : kind === 'click' ? r.click(id).ok : kind === 'form' ? r.useForm(id, value).ok : kind === 'item' ? r.useItem(id, value).ok : r.useChoice(id, value).ok;
    expect(result, `${view} ${id}`).toBe(true); await afterStep();
  };
  for (const page of ['A1','A2','A3','A4','B1','B2','B3','B4']) await run('A','click','hs_a_paper_'+page);
  await run('A','click','hs_a_paper_sort');
  expect(A.useForm('hs_a_paper_sort', { 海海稿:'B1→B2→B3→B4', 小明稿:'A1→A2→A3→A4' }).ok).toBe(false);
  await run('A','form','hs_a_paper_sort',{海海稿:'A1→A2→A3→A4',小明稿:'B1→B2→B3→B4'});
  expect(A.useForm('hs_a_scanner', {海海稿第三页:'A1',海海稿第四页:'A4',小明稿第三页:'B3',小明稿第四页:'B4'}).ok).toBe(false);
  expect(A.getInventory().some(i=>i.itemId==='ev_author')).toBe(false);
  await run('A','form','hs_a_scanner',{海海稿第三页:'A3',海海稿第四页:'A4',小明稿第三页:'B3',小明稿第四页:'B4'});
  expect(A.getCurrentView()).toBe('A'); expect(A.getCurrentScene()).toBe('main');
  if (A !== B) expect(B.getCurrentView()).toBe('B');
  await run('B','click','hs_b_send_entry'); await run('B','click','hs_b_send_evidence');
  await run('B','click','hs_b_send_track'); await run('B','click','hs_b_relay_node'); await run('B','click','hs_b_relay_evidence');
  await run('B','click','hs_b_relay_track'); await run('B','click','hs_b_receiver_node'); await run('B','click','hs_b_receive_evidence');
  await run('B','go','main'); await run('B','click','hs_b_execution');
  await run('A','go','main'); await run('A','click','hs_a_evidence_entry');
  expect(A.useItem('hs_a_evidence_slot_0','ev_receive').ok).toBe(false);
  expect(A.click('hs_a_check').ok).toBe(false);
  for (const [i, ev] of ['ev_author','ev_send','ev_transit','ev_receive','ev_exec'].entries()) await run('A','item','hs_a_evidence_slot_'+i,ev);
  await run('A','click','hs_a_check'); await run('A','go','main'); await run('A','item','hs_a_stamp','restored_task');
  await run('B','go','receiver'); await run('B','item','hs_b_replace','restored_task'); await run('B','click','hs_b_verify'); await run('B','click','hs_b_log');
  expect(B.useChoice('hs_b_timeline','争执 → 主展区断电 → 海海离开 → 小明信号消失').ok).toBe(false);
  await run('B','choice','hs_b_timeline','争执 → 海海离开 → 主展区断电 → 小明信号消失');
  expect(A.getStatus()).toBe('success'); expect(B.getStatus()).toBe('success');
}

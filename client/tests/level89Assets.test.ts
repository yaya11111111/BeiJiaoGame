import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
function size(file: string): number[] {
 const b=readFileSync(file); if(b[0]===137)return [b.readUInt32BE(16),b.readUInt32BE(20)];
 let i=2; while(i<b.length){if(b[i++]!==255)continue;while(b[i]===255)i++;const marker=b[i++];const length=b.readUInt16BE(i);if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return [b.readUInt16BE(i+5),b.readUInt16BE(i+3)];i+=length;}
 throw new Error(`无法读取图片 ${file}`);
}
describe('第八至十关现图导入',()=>{
 it.each(['08','09','10'])('L%s 热点位于对应原图内',level=>{
  const c=JSON.parse(readFileSync(resolve(root,`resources/configs/level.${level}.json`),'utf8'));
  for(const v of Object.values(c.views) as any[])for(const h of v.hotspots){const path=resolve(root,'levels',v.scenes[h.scene].assetKey);const d=size(path+(existsSync(path+'.jpg')?'.jpg':'.png'));expect(h.rect[0]+h.rect[2],h.nodeId).toBeLessThanOrEqual(d[0]);expect(h.rect[1]+h.rect[3],h.nodeId).toBeLessThanOrEqual(d[1]);}
 });
});

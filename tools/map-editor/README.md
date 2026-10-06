# 地图区域标注工具

用于根据图二和图三微调主校区地图的区域边界与关卡点位。

## 使用

在项目根目录启动一个静态服务器，例如：

```powershell
python -m http.server 5173
```

然后打开：

`http://localhost:5173/tools/map-editor/`

选择“画区域”后点击边界拐点，点“完成当前区域”保存；选择“标关卡”后点击或拖动对应编号。最后点击“导出 map-layout.txt”。

坐标以 `client/assets/resources/images/bjtu-main-campus-map.jpg` 原图左上角为原点，同时导出百分比坐标和像素坐标。

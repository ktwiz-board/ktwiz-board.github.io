# 화면 점검 도구

헤드리스 크롬으로 보드를 열어 오류·가로 넘침·이상 값(undefined/NaN)을 점검하고 스크린샷을 남깁니다.

```bash
LOCALDATA=data/live.json node tools/screencheck/cdp.js "file:///E:/0%ED%81%B4%EB%A1%9C%EB%93%9C/ktwiz-board/index.html" 1280 900 tools/screencheck/audit.js shot.png light
node tools/screencheck/cdp.js https://ktwiz-board.github.io/ 390 844 tools/screencheck/audit.js -
```

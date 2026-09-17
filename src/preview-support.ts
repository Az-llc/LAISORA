// プレビュー用 HTML ページ専用のグローバルビルド入口。そのページは classic script なので
// ESM を import できず、モック用イベントへ配置情報を載せられない。ここを経由して
// 実物の reducer と projectWorkEvent を渡す（preview 側で注釈を再実装すると、
// 実装とずれても preview だけが正しく見えてしまう）。
export { createWorkModelState, reduceWorkModel } from "./work-model";
export { projectWorkEvent, PROTOCOL_VERSION } from "./protocol";

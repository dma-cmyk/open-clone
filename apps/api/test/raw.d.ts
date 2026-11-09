// Vite の `?raw` import（公式サンプルの原文をテストで読む）の型。
declare module "*?raw" {
  const content: string;
  export default content;
}
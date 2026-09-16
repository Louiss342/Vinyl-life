// 构建产物 gateway-bundle / style-bundle 的兜底类型声明（两个 .ts 由 esbuild 生成，见 .gitignore）。
// 不先 build 就跑 tsc / eslint 的环境（例如社区插件审核的静态扫描）里，模块解析不到文件会被当成
// error typed（any），使用处随之报 no-unsafe-argument。这里补上类型；真正的文件在场时以文件为准。
declare module '*/gateway-bundle' {
  export const GATEWAY_GZIP: string;
  export const GATEWAY_HASH: string;
}

declare module '*/style-bundle' {
  export const STYLE_GZIP: string;
}

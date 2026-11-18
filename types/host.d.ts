/**
 * 宿主注入物的类型声明（只为 tsc 门禁服务，运行时不存在任何东西，也不发布）。
 *
 * 注意：这是**脚本作用域**的 .d.ts（没有 import/export），所以 interface Window
 * 直接就是全局合并；一旦加了 export {} 就会变成模块，`declare global` 内外都得再包一层。
 */

interface Window {
  /** dsh-client-modules 注入的加载器：包根 client.js 用它在浏览器侧注册一个插件模块。 */
  __ModuleLoader__?: {
    load: (spec: { id: string; factory: (require: (name: string) => any) => any }) => any;
  };
  /** 测试用：把 client/ 子模块的基址从 /tagger/api/_mod/ 改成 file:// 目录。 */
  __DSH_TAGGER_MODBASE__?: string;
  /** 面板装载过的子模块缓存（同名模块只 import 一次）。 */
  __DSH_TAGGER_MODS__?: Record<string, any>;
}

/**
 * React 由宿主以 CJS 形式 require 进来（浏览器侧没有 node_modules），
 * 这里只声明成 any —— 门禁要的是「名字存在」，不是真去校 React 的类型。
 */
declare module "react" {
  const React: any;
  export = React;
}

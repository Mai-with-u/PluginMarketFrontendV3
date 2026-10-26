// 给 React 补上尚未进入 @types/react 的 DOM 新属性。
declare module "react" {
  interface HTMLAttributes<T> {
    /** HTML-in-Canvas：canvas 子元素可被 drawElementImage / drawElementImageToTexture 绘制 */
    drawable?: "" | undefined;
  }
  interface CanvasHTMLAttributes<T> {
    /** HTML-in-Canvas 旧版草案的属性名，部分 Canary 仍只认它 */
    layoutsubtree?: "" | undefined;
  }
  interface DialogHTMLAttributes<T> {
    /** 轻触背景关闭：closedby="any" */
    closedby?: "any" | "closerequest" | "none" | undefined;
  }
  interface CSSProperties {
    [customProperty: `--${string}`]: string | number | undefined;
  }
}

// 让本文件成为模块，上面的 declare module 才是增补而不是覆盖。
// oxlint-disable-next-line unicorn/require-module-specifiers
export {};

import { defineConfig } from 'wxt';

/**
 * WXT 配置
 *
 * 注意两处踩过的坑（已实测）：
 *  1. modules 必须用「字符串」形式 '@wxt-dev/module-vue'。
 *     传对象会报 `Cannot find package '[object Object]'`，
 *     传 vue() 会报 `is not a function` —— 该模块导出的是已定义好的模块对象。
 *  2. TypeScript 锁 5.9.3 而非最新的 7.x：
 *     vue-tsc@3.x 依赖 TS 编译器内部路径 './lib/tsc'，
 *     而 TS 7（Go 重写版）不再导出该路径，会导致 .vue 模板类型检查完全失效。
 *     参见 vuejs/language-tools#6124。
 */
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],

  /**
   * 【必须删掉 side_panel.default_path】
   *
   * WXT 只要发现 sidepanel 入口，就会**无条件**写入
   *     side_panel: { default_path: 'sidepanel.html' }
   * （node_modules/wxt/dist/core/utils/manifest.mjs:163-176），
   * 在 manifest 配置里不写该字段并不能阻止它。
   *
   * 而这个字段的语义是「全局默认面板」：任何**没有专属配置**的标签页
   * 都会回退去显示它。于是会出现——
   *   在 A 页展开侧边栏 → 切到 B 页 → B 页没有专属配置 →
   *   浏览器拿全局默认面板顶上 → 面板看起来「跟着用户到处跑」。
   *
   * 面板路径改由代码按标签页下发，并在启动时全局禁用。
   * 两半缺一不可，见 entrypoints/background.ts。
   * 参考 GoogleChrome/chrome-extensions-samples#987。
   */
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      delete manifest.side_panel;
    },
  },

  srcDir: '.',
  entrypointsDir: 'entrypoints',
  publicDir: 'public',
  outDir: '.output',

  manifest: {
    name: 'BiliLens — B站视频 AI 精读',
    short_name: 'BiliLens',
    description:
      '一键提取 B站视频的官方 AI 总结与字幕，用你自己的大模型生成带时间戳的结构化笔记。无需下载视频、无需填写 Cookie。',
    version: '1.0.0',
    minimum_chrome_version: '116',

    permissions: ['storage', 'sidePanel', 'downloads', 'tabs', 'scripting'],

    // B站接口域名固定，声明在必需权限里
    host_permissions: ['https://*.bilibili.com/*', 'https://*.hdslb.com/*'],

    // 大模型端点由用户自填（中转站/自建），安装时不知道域名，
    // 因此走 optional_host_permissions + 保存时按需申请
    optional_host_permissions: ['https://*/*', 'http://*/*'],

    action: {
      default_title: 'BiliLens — 精读当前视频',
      default_icon: {
        16: 'icons/icon16.png',
        32: 'icons/icon32.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    },

    /*
     * 【刻意不声明 side_panel.default_path】
     *
     * 声明了它，就等于给扩展注册了一个**全局默认面板**：
     * 任何没有专属配置的标签页都会回退去显示它。
     * 于是「在 A 页展开，切到 B 页却还开着」——
     * 因为 B 页没有专属配置，浏览器拿全局默认面板顶上了。
     *
     * 面板路径改由代码按标签页下发：
     *   sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true })
     * 并在启动时全局禁用，见 entrypoints/background.ts。
     * 参考 GoogleChrome/chrome-extensions-samples#987。
     */

    options_ui: {
      open_in_tab: true,
    },

    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },

  vite: () => ({
    build: {
      // 侧边栏体积不敏感，保留可读性便于排查
      minify: false,
      sourcemap: false,
    },
  }),
});

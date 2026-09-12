import { createApp } from 'vue';
import App from './App.vue';
import '@/assets/theme.css';
import './style.css';
// KaTeX 样式与字体：公式渲染用。字体由打包器从 CSS url() 带进扩展产物
import 'katex/dist/katex.min.css';
import { applyFontScale } from '@/lib/fontScale';

/*
 * 在挂载之前先把字号档位写到 <html> 上。
 *
 * 这一步必须早于 createApp().mount()：等 Vue 挂载后再改，
 * 用户会先看到小字、再跳成大字。storage 是异步的，因此这里
 * 用 await；await 的代价只是一帧空白，比闪一下好。
 */
await applyFontScale();

createApp(App).mount('#app');

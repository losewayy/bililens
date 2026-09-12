/**
 * scripts/dump-prompts.mjs —— 打印发给模型的完整提示词
 *
 * 与其凭记忆复述，不如直接把真实的组装结果打出来——
 * 这样看到的就是真正发出去的东西。
 *
 * 实现说明：lib/llm.ts 里用了 TS 的「参数属性」写法
 * （constructor(readonly status?: number)），
 * Node 自带的 strip-only 类型擦除不支持该语法，因此这里借 Vite 的
 * SSR 加载器来编译，而不是让 Node 直接吃 .ts。
 *
 * 用法：
 *   node scripts/dump-prompts.mjs           # 打印两份系统提示
 *   node scripts/dump-prompts.mjs note      # 笔记的完整两条消息
 *   node scripts/dump-prompts.mjs chat      # 聊天的完整消息序列
 */

import { resolve } from 'node:path';
import { createServer } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true },
  appType: 'custom',
});

const { buildNoteMessages, buildChatMessages, buildMaterial, NOTE_SYSTEM, CHAT_SYSTEM } =
  await server.ssrLoadModule('/lib/llm.ts');

/** 与 e2e 用的真实视频一致的样例素材 */
const info = {
  title: '看B站视频自动生成字幕',
  upName: '乒向北方',
  duration: 95,
  bvid: 'BV1f4421f7ex',
  desc: '演示如何给 B站视频自动生成字幕。',
};

const conclusion = {
  available: true,
  summary: '视频演示了用工具自动为 B站视频生成字幕的完整流程。',
  outline: [
    { title: '开场介绍', timestamp: 0, points: [{ timestamp: 8, content: '说明要解决的问题' }] },
  ],
};

const subtitle = [
  { from: 0, content: '大家好，今天讲怎么给 B站视频自动生成字幕。' },
  { from: 8, content: '首先打开工具，选择视频文件。' },
  { from: 24, content: '它会自动识别语音并生成时间轴。' },
  { from: 45, content: '最后导出字幕文件就可以了。' },
];

const payload = { info, conclusion, subtitle };
const which = process.argv[2];

const rule = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

if (!which) {
  rule('【笔记】system');
  console.log(NOTE_SYSTEM);
  rule('【聊天】system');
  console.log(CHAT_SYSTEM);
  rule('【共用素材】buildMaterial() 的产物（笔记与聊天完全相同）');
  console.log(buildMaterial(payload));
  console.log('\n提示：node scripts/dump-prompts.mjs <note|chat> 可看完整消息序列');
} else if (which === 'note') {
  console.log('='.repeat(72));
  console.log('笔记：实际发送的两条消息');
  console.log('='.repeat(72));
  for (const m of buildNoteMessages(payload)) {
    rule(`role: ${m.role}   （${m.content.length} 字符）`);
    console.log(m.content);
  }
} else if (which === 'chat') {
  console.log('='.repeat(72));
  console.log('聊天：实际发送的消息序列（含一轮历史 + 播放位置）');
  console.log('='.repeat(72));
  const history = [
    { role: 'user', content: '这个视频解决什么问题？' },
    { role: 'assistant', content: '它演示了自动生成字幕的完整流程 [0:00]。' },
    { role: 'user', content: '这里讲了什么？' },
  ];
  for (const m of buildChatMessages(payload, history, { playhead: 24 })) {
    rule(`role: ${m.role}   （${m.content.length} 字符）`);
    console.log(m.content);
  }
} else {
  console.error(`未知参数: ${which}（可选：note / chat）`);
  process.exitCode = 1;
}

await server.close();

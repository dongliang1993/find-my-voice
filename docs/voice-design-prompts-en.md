# Voice Design 提示词 · 英文锚定版

英文母语锚定的四个角色，两女两男。跟 [中文锚定版](./voice-design-prompts.md) 是**互斥的两套**，不是互补——同一段描述配两套预览文本，出来的会是两种不同的音色。

## 锚定英文之后，什么变了

| | 中文锚定 | 英文锚定（本文件） |
|---|---|---|
| 英文表现 | 流畅但平，气声和慵懒基本掉光 | 完整保留 |
| 中文表现 | 完整保留 | 流畅、无口音，但**只剩下音色和语速，情绪颗粒度掉一档** |
| 主要塌陷点 | 声调被压平 → 嘟囔糊音 | 气泡音失控 → 沙哑成烟嗓、拖成 ASMR |

所以英文版的防塌陷锚点换了一批：`soft vocal fry ... without turning croaky`、`fully voiced, not whispery`、`falling intonation, no upspeak`。

## 通用参数

同中文版：`eleven_multilingual_ttv_v2`，guidance scale **30–40%**，预览文本首轮 150–200 字符、定稿拉到 250 字符。

**预览文本必须用英文写。** 官方：语言由文本决定，写什么语言就是什么语言的母语者。

---

## A · 女 / 沙哑低音，深夜贴耳

```
Native English, General American, no regional accent. Female, 30–34. Excellent quality.
Persona: late-night confidante. Emotion: sultry, unhurried, a little amused.
Low-pitched and husky with a warm grain in the lower register and soft vocal fry on phrase endings, never croaky. Breathy but fully voiced and close to the mic. Relaxed, not sleepy — consonants stay clean and every word lands. Sentences settle downward and trail off slowly, as if she has all night.
```

> It's late and you're still up. Mm. I wasn't going to talk you out of it anyway. Once the lights are off, a room gets quiet enough that you can hear your own heartbeat. Hold the phone a little closer — some things only sound right up against your ear. So. Tell me what happened today.

## B · 女 / 暖丝绒中低音，松弛笃定

```
Native English, General American, no regional accent. Female, 33–38. Excellent quality.
Persona: the one who never rushes you. Emotion: warm, velvety, quietly confident.
Mid-low and velvet-smooth with rounded resonance and no edge, breath supported low in the chest. Speaks at a slow, even pace with long soft pauses between thoughts. Intimate and grounded rather than playful. Relaxed, not sleepy, falling intonation throughout.
```

> You don't have to answer me yet. Put the cup down first. Lean back. Let your shoulders drop. That's it. You worked hard today — the rest of it can wait until tomorrow. I'm right here. No rush. We'll take our time.

## C · 男 / 深胸腔低音，少言沉稳

```
Native English, General American, no regional accent. Male, 35–40. Excellent quality.
Persona: the calm voice in a dark room. Emotion: deep, low-key, reassuring.
Deep chesty baritone with dark rounded resonance and a faint rasp on the low end, breathing close and unhurried. Speaks slowly and sparsely, letting silence do half the work. Warm downward intonation and clean articulation. Relaxed, not sleepy.
```

> Mm. I know you don't feel like talking today. That's fine. Let me. Close your eyes and just listen to my voice — put everything else down for now. It's late. Whatever's out there has nothing to do with tonight. I'll sit here with you.

## D · 男 / 轻哑干嗓，懒散带笑意

```
Native English, General American, no regional accent. Male, 30–35. Excellent quality.
Persona: unbothered, faintly wry. Emotion: dry, lazy, amused.
Lightly raspy mid-low voice with a dry texture and a lazy downward drift at the end of phrases. Casual and under-energized, with a soft breath of amusement underneath. Relaxed, not sleepy, consonants still crisp.
```

> Up late again. Yeah, thought so. Fine — let's skip the lecture about sleep and talk about something else. Like the fact that you're lying there flat on your back scrolling. Ha. Got you. Don't move. Stay right there. I'll keep you company for a while.

---

## 换成英式口音

把第一句的方言段替换掉，其余不动：

```
Native English, modern Received Pronunciation (British), no regional accent.
```

只换 A、B 两条就好——RP 的女声天然偏「上流冷感」，跟 `amused` 打架，配 D 尚可，配 C 会变成 BBC 主播。

## 保存后

Stability 0.45–0.55，Similarity 0.75–0.85。然后**拿中文文本单独试一遍**——中文靠 v4 跨语言生成，别用英文预览里的语气去判断它说中文好不好。

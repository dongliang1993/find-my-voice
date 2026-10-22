# Voice Design 提示词：中英双语 · 慵懒性感

按 ElevenLabs 官方 [Voice Design 提示词指南](https://elevenlabs.io/docs/product-guides/voices/voice-design) 的推荐格式写成，四个角色，两女两男。

## 先看三条硬约束

1. **一次生成只能锚定一种语言。** 预览文本用中文写，生成的就是中文母语者。英文靠 Eleven v4 的 native accent handling 说，能说，但情绪颗粒度会掉一档。真要英文也饱满，就用同一段描述再生成一版英文锚定的孪生声音。
2. **预览文本是半个提示词。** 官方原话：文本像是表演脚本，跟描述打架会产出不自然的音色。所以下面每条的预览文本都是按角色写的，**不要换成别的句子**。
3. **"慵懒" 的两个塌陷点**：气声多了变成 ASMR 耳语（听不清字），语速慢了变成拖沓糊音。所以四条描述里都埋了 `breathy but not whispered`、`relaxed, not sleepy`、`clear consonants` 三个防塌陷锚点。

## 通用参数

| 项 | 值 | 理由 |
|---|---|---|
| Model | `eleven_multilingual_ttv_v2` | 设计端点只有 v2 / v3，v2 更稳 |
| Guidance scale | UI 30–40%（API `guidance_scale` 3.0–4.0） | 描述已够细，官方建议细描述配低 scale；超过 45 会发硬 |
| 预览文本长度 | 首轮 150–200 字，定稿拉到 250 字 | 越长越稳，但按字符扣费 |
| Loudness | 默认 0.5 | — |

生成后听三件事：气声是否盖过字头、语速是否停在「慢而不拖」、句尾是否还有下沉的慵懒感。三条同时过，才保存。

保存进应用后：Stability 0.45–0.55（保住那种松的质地），Similarity 0.75–0.85。

---

## A · 女 / 沙哑低音，深夜贴耳

```
Native Mandarin Chinese, standard Putonghua with no regional accent. Female, 30–34. Excellent quality.
Persona: late-night confidante. Emotion: sultry, unhurried, a little amused.
Low-pitched and husky with a soft grain in the lower register, breathy but never whispered, close to the mic. Relaxed, not sleepy — consonants stay clean and every word lands. Sentences trail off slowly at the end, as if she has all night.
```

**预览文本（中文）**

```
这么晚还不睡啊……嗯，我也没打算劝你。反正灯一关，房间会变得特别安静，安静到你连自己心跳都听得见。你把手机拿近一点就好，别开免提——有些话，只适合贴着耳朵说。……好了，说吧，今天到底怎么了。
```

**英文校验用**

```
It's late and you're still up. Mm. I wasn't going to talk you out of it anyway. Once the lights are off, a room gets quiet enough that you can hear your own heartbeat. Hold the phone a little closer — some things only sound right up against your ear. So. Tell me what happened today.
```

---

## B · 女 / 暖丝绒中低音，松弛笃定

```
Native Mandarin Chinese, standard Putonghua with no regional accent. Female, 33–38. Excellent quality.
Persona: the one who never rushes you. Emotion: warm, velvety, quietly confident.
Mid-low and velvet-smooth with rounded resonance and no edge. Speaks at a slow, even pace with long soft pauses between thoughts, breath support low in the chest. Intimate and grounded rather than playful — relaxed, not sleepy.
```

**预览文本（中文）**

```
你不用急着回答我。先把杯子放下，靠回去，把肩膀松一松。……对，就是这样。今天你已经很努力了，剩下那点没做完的事，明天再说也来得及。我在这儿呢，不急，我们慢慢聊。夜还长。
```

**英文校验用**

```
You don't have to answer me yet. Put the cup down first. Lean back. Let your shoulders drop. That's it. You worked hard today — the rest of it can wait until tomorrow. I'm right here. No rush. We'll take our time.
```

---

## C · 男 / 深胸腔低音，少言沉稳

```
Native Mandarin Chinese, standard Putonghua with no regional accent. Male, 35–40. Excellent quality.
Persona: the calm voice in a dark room. Emotion: deep, low-key, reassuring.
Deep chesty baritone with dark rounded resonance, a faint rasp on the low end, breathing close and unhurried. Speaks slowly and sparsely, letting silence do half the work, with warm downward intonation and clean articulation. Relaxed, not sleepy.
```

**预览文本（中文）**

```
嗯……我知道你今天不太想说话。没关系，那就我来说。你把眼睛闭上，听我的声音就行，别的都先放一放。……夜深了，外面那些事，今晚都跟你没关系。剩下的我陪你耗着。
```

**英文校验用**

```
Mm. I know you don't feel like talking today. That's fine. Let me. Close your eyes and just listen to my voice — put everything else down for now. It's late. Whatever's out there has nothing to do with tonight. I'll sit here with you.
```

---

## D · 男 / 轻哑干嗓，懒散带笑意

```
Native Mandarin Chinese, standard Putonghua with no regional accent. Male, 30–35. Excellent quality.
Persona: unbothered, faintly wry. Emotion: dry, lazy, amused.
Lightly raspy mid-low voice with a dry texture and a lazy downward drift at the end of phrases. Casual and under-energized, with a soft breath of amusement underneath — relaxed, not sleepy, consonants still crisp.
```

**预览文本（中文）**

```
又熬夜了？我猜也是。……行吧，那我们就不聊早睡了，聊点别的。比如你现在这个姿势，是不是又瘫在那儿刷手机。……呵，被我说中了吧。行了，别动，就这么躺着，我陪你说会儿话。
```

**英文校验用**

```
Up late again. Yeah, thought so. Fine — let's skip the lecture about sleep and talk about something else. Like the fact that you're lying there flat on your back scrolling. Ha. Got you. Don't move. Stay right there. I'll keep you company for a while.
```

---

## 对照官方规则的自查

| 官方规则 | 这里怎么落 |
|---|---|
| 第一句钉死语言与方言 | `Native Mandarin Chinese, standard Putonghua with no regional accent` |
| 用推荐模板 | 语言 → 性别/年龄 → 音质 → Persona → Emotion → 音色/语速/发声 |
| 不用 accent 表达语调 | 语调只写 `downward intonation`、`trailing off` |
| 不用 FX 词 | 全篇无 reverb / echo / phone / tape |
| 气声要配防塌陷 | `breathy but never whispered` + `clear consonants` |
| 预览文本与描述同调 | 四条预览都是深夜、慢、贴耳的语气，无感叹号堆叠 |
| 年龄要具体 | 全部用区间而非 "young" |

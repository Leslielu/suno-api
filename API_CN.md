# suno-api 中文 API 调用说明

> 本文档针对当前部署(已改造:网页端 v2-web 接口、试听版过滤、多账号轮询)。

## 服务地址与鉴权

| 项 | 值 |
|---|---|
| Base URL | 部署机的 `http://<host>:3000`(默认端口 3000) |
| 鉴权 | **无 API key**(项目原生不支持)。如需指定某个 Suno 账号,在请求头加 `Cookie: <该账号整串 cookie>` |
| 在线文档 / 在线测试 | `http://<host>:3000/docs` |

**账号选择行为**

- 生成类请求**不带 Cookie** → 账号池自动**轮流**(round-robin),某账号无积分自动跳过
- 生成类请求**带 Cookie** → 强制使用该指定账号
- 查询类(`/api/get`、`/api/get_limit`、`/api/get_aligned_lyrics`)→ 读请求 Cookie;不指定时用默认账号

---

## ① 自定义生成 `/api/custom_generate`(最常用,给歌词 + 风格)

```bash
curl -X POST http://<host>:3000/api/custom_generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "[Verse]\n夜色很深\n星星在等\n[Chorus]\n带我飞向那片光",
    "tags": "chinese pop rock, male vocal, anthemic, emotional",
    "title": "我的歌",
    "make_instrumental": false,
    "model": "chirp-auk-turbo",
    "wait_audio": true,
    "negative_tags": ""
  }'
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | **歌词**。可用 `[Verse]` / `[Chorus]` / `[Bridge]` 等结构标记,`\n` 换行 |
| `tags` | string | 音乐风格,如 `chinese pop rock, male vocal, emotional` |
| `title` | string | 歌曲标题 |
| `negative_tags` | string | 不想要的风格(可选) |
| `make_instrumental` | bool | `true` = 纯音乐(无人声) |
| `model` | string | **默认 `chirp-auk-turbo`**(免费账号可用)。⚠️ 不要用 `chirp-v3-5` / `v4` / `fenix`——会 403 或被当试听过滤掉 |
| `wait_audio` | bool | `true` = 等生成完再返回(含 `audio_url`);`false` = 立即返回 id,需自行轮询 `/api/get` |

**返回**:clips 数组。免费账号**只返回完整版**(chirp-auk),60 秒试听版(fenix)已自动过滤。

```json
[
  {
    "id": "...",
    "title": "我的歌",
    "model_name": "chirp-auk",
    "status": "streaming",
    "audio_url": "https://cdn1.suno.ai/xxxxx.mp3",
    "video_url": "...",
    "lyric": "...",
    "tags": "...",
    "duration": "..."
  }
]
```

---

## ② 简单描述模式 `/api/generate`(一句话描述,自动写词)

```bash
curl -X POST http://<host>:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "一首关于夜晚的中文流行歌,男声,温柔",
    "make_instrumental": false,
    "wait_audio": true
  }'
```

参数:`prompt`(描述)、`make_instrumental`、`model`、`wait_audio`。

---

## ③ OpenAI 兼容 `/v1/chat/completions`(可接入 GPTs / Agent)

```bash
curl -X POST http://<host>:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{ "messages": [ { "role": "user", "content": "一首关于海洋的轻快歌曲" } ] }'
```

返回 markdown 字符串(歌名 + 封面图 + 歌词 + 试听链接)。**同样走账号池轮询**。

---

## ④ 其他端点速查

| 端点 | 方法 | 参数 | 用途 |
|---|---|---|---|
| `/api/generate_lyrics` | POST | `prompt` | 根据描述生成歌词 |
| `/api/extend_audio` | POST | `audio_id`、`prompt`、`continue_at`(mm:ss)、`tags`、`title`、`model`、`wait_audio` | 续写 / 延长一首歌 |
| `/api/generate_stems` | POST | `audio_id` | 分离人声 / 伴奏轨道 |
| `/api/concat` | POST | `clip_id` | 把 extend 片段拼接成整首 |
| `/api/get` | GET | `?ids=id1,id2`(可省,省略返回全部) | 查歌曲信息(轮询生成状态用) |
| `/api/get_limit` | GET | 无 | 查额度 |
| `/api/clip` | GET | `?id=` | 查单个 clip |
| `/api/get_aligned_lyrics` | GET | `?id=` | 歌词逐字时间戳 |

---

## ⑤ 生成状态轮询(`wait_audio: false` 时)

```bash
# 1) 提交(立即返回 id)
curl -s -X POST http://<host>:3000/api/custom_generate \
  -H "Content-Type: application/json" \
  -d '{ "prompt":"...", "tags":"pop", "title":"x", "model":"chirp-auk-turbo", "wait_audio":false }'
# → [{ "id":"aaa", ... }, { "id":"bbb", ... }]

# 2) 轮询直到 status = complete
curl "http://<host>:3000/api/get?ids=aaa,bbb"
```

状态流转:`submitted → queued → streaming → complete`(`complete` 后才有可下载的 cdn mp3)。

---

## ⑥ 错误码

| HTTP 码 | 含义 |
|---|---|
| **503** `All accounts have no credits left` | 所有账号积分都耗尽了 |
| **402** `Payment required` | 当前账号无额度(账号池会自动换号,正常极少见到) |
| **500** | 其他错误(看响应 `error` 字段) |

---

## ⑦ 重要注意事项

1. **免费账号额度**:每账号约 50 credits / 天,每次生成消耗约 10。多账号轮询可线性叠加日上限。
2. **指定账号生成 / 查额度**:在请求头加 `Cookie: <某账号整串 cookie>`。例如查某账号余额:
   ```bash
   curl -H "Cookie: <某账号整串>" http://<host>:3000/api/get_limit
   ```
3. **模型保持 `chirp-auk-turbo`**:不要用 `chirp-v3-5`(上游过时默认,免费账号 403)。
4. **试听版已过滤**:只会收到完整版(auk),不会收到 60 秒的 fenix 试听片段。
5. **加更多账号**:把新 cookie 用 `|||` 拼到 `.env` 的 `SUNO_COOKIES` 末尾,重启服务即可:
   ```
   SUNO_COOKIES=账号A的cookie|||账号B的cookie|||账号C的cookie
   ```

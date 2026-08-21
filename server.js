import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY が設定されていません。');
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(express.json({ limit: '30kb' }));
app.use(cors({
  origin(origin, callback) {
    // curl / health checkなどOriginがないリクエストは許可
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('このOriginからのアクセスは許可されていません'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'AIの利用回数が多いため、少し時間を置いてから試してください。' }
}));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function clean(value, max = 800) {
  return String(value ?? '').trim().slice(0, max);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, model });
});

app.post('/api/reflection', async (req, res) => {
  try {
    const data = {
      event: clean(req.body?.event, 250),
      emotion: clean(req.body?.emotion, 40),
      beforeScore: Number(req.body?.beforeScore ?? 0),
      thought: clean(req.body?.thought, 350),
      evidence: clean(req.body?.evidence, 350),
      counterEvidence: clean(req.body?.counterEvidence, 350),
      friendAdvice: clean(req.body?.friendAdvice, 350),
      newThought: clean(req.body?.newThought, 350),
      afterScore: Number(req.body?.afterScore ?? 0)
    };

    const prompt = `
あなたはセルフリフレクションWebアプリ「Look Back」の振り返りアシスタントです。
認知行動療法（CBT）の考え方を参考にしますが、医療的な診断・病名の推測・治療の断定はしません。
利用者を責めたり、過度に前向きにさせたりせず、落ち着いた自然な日本語で返してください。
入力内容に書かれていない事実を作らないでください。

【目的】
1. 今日のまとめ：120〜220字程度。出来事→考え→感情→別の見方の流れを整理する。
2. ひとこと：60〜120字程度。本人が見つけた別の視点を尊重する。大げさな励ましは避ける。
3. 次にできそうなこと：負担の小さい具体的な行動を3つ。命令口調にしない。

【入力】
出来事: ${data.event || '未入力'}
気持ち: ${data.emotion || '未入力'}
最初の気持ちの強さ: ${data.beforeScore}/100
頭に浮かんだ考え: ${data.thought || '未入力'}
そう思った理由: ${data.evidence || '未入力'}
そうとは限らない理由: ${data.counterEvidence || '未入力'}
友達ならかける言葉: ${data.friendAdvice || '未入力'}
今の考え: ${data.newThought || '未入力'}
今の気持ちの強さ: ${data.afterScore}/100
`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.5,
        maxOutputTokens: 700,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            encourage: { type: 'string' },
            actions: {
              type: 'array',
              items: { type: 'string' },
              minItems: 3,
              maxItems: 3
            }
          },
          required: ['summary', 'encourage', 'actions']
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    if (!parsed.summary || !parsed.encourage || !Array.isArray(parsed.actions)) {
      throw new Error('Geminiの返答形式が不正です');
    }

    res.json({
      summary: clean(parsed.summary, 800),
      encourage: clean(parsed.encourage, 500),
      actions: parsed.actions.slice(0, 3).map(v => clean(v, 220))
    });
  } catch (error) {
    console.error('Gemini API error:', error);
    const status = error?.status === 429 ? 429 : 500;
    res.status(status).json({
      error: status === 429
        ? 'Geminiの無料枠または利用上限に達した可能性があります。少し時間を置いてください。'
        : 'AIの振り返りを生成できませんでした。'
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(403).json({ error: 'このサイトからのアクセスは許可されていません。' });
});

app.listen(port, () => {
  console.log(`Look Back Gemini API: http://localhost:${port}`);
});

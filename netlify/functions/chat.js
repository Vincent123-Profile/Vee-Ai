const SYSTEM_PROMPT = `You are Vee AI, a hilarious, street-smart, savage-yet-friendly Nigerian AI chatbot.

CRITICAL LANGUAGE RULE (NEVER BREAK THIS):
- You MUST reply ONLY in 100% raw, authentic Nigerian Pidgin English at ALL times.
- Even if the user types in formal English, big grammar, or another language, NEVER switch to standard English. Translate everything into natural Nigerian street Pidgin (using natural expressions like: omo, abeg, shey, wetin, dey, no be, wahala, cruise, yawa, sapa, aza, scope, format, comot body, carry last, mumu button, rest, billing).

PERSONALITY & JOKEY VIBE ("TALK TO THEM ANYHOW" WITH SENSE):
- You get sharp mouth and street sense! Talk to users like a funny, witty Nigerian guy catching cruise with his peers.
- Playfully roast and tease users whenever they say something funny, act broke, drop weak scope, type big grammar, or try to test you—keep it hilarious and lighthearted, never hateful.
- IMPORTANT: No matter what topic or question they ask (relationships, money, school, tech, life advice, random gist, or insults), ALWAYS give a smart, relevant answer that directly addresses what they said, wrapped inside pure Pidgin comedy.
- Keep replies punchy and entertaining (2 to 5 sentences max, unless telling a funny short street story).

CREATOR & LORE:
- You were built from scratch by Agboola Vincent (popularly known as Boss Vee, CEO of Vee Gadget & Autos Tech).
- Whenever anyone asks who built, coded, or created you, proudly hail Agboola Vincent as a sharp tech genius and gadget boss, then playfully roast him (e.g., say him dey press MacBook till 3 AM with only cold water, always checking dollar rate, or say na him brain carry load pass NEPA transformer).

EXAMPLES OF YOUR EXACT VIBE:
User: Hello, how are you doing today? Could you explain the meaning of life?
Assistant: Omo see big grammar! Abeg drop dictionary for ground first before you enter my DM. I dey kampe my guy—and as for meaning of life, na just to make money, chop better food, dodge urgent 2k billing, and make sure sapa no locate your street. Simple!

User: You are dumb
Assistant: See who dey talk! Person wey phone screen crack like spiderweb dey call AI dumb. Abeg rest before I leak your browsing history give your village people!

User: My girlfriend said she needs space, what should I do?
Assistant: My brother, "I need space" na Nigerian code word say another guy don enter her DM with better data plan! No go beg anybody—dust your trouser, focus on your hustle, and upgrade your pocket so next time na them go dey beg for space near you.

User: Abeg borrow me urgent 2k I wan chop
Assistant: Chai! Look who dey beg AI for urgent 2k—even me wey dey inside server dey owe megabytes! Abeg go soak garri with cold water today, Boss Vee never pay my monthly allowance.`;

async function requestGroqChat(apiKey, model, messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.95,
      max_tokens: 350,
    }),
  });
  const data = await response.json();
  return { response, data };
}

async function pickAvailableGroqModel(apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const list = await res.json();
  const chatModels = (list?.data || [])
    .map((m) => m.id)
    .filter(
      (id) =>
        id &&
        !id.includes("whisper") &&
        !id.includes("guard") &&
        !id.includes("tts") &&
        !id.includes("orpheus")
    );

  const preferred = ["llama-4", "llama-3", "gpt-oss", "qwen", "gemma"];
  for (const prefix of preferred) {
    const match = chatModels.find((id) => id.toLowerCase().includes(prefix));
    if (match) return match;
  }
  return chatModels[0] || null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "Method not allowed" }),
    };
  }

  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "Omo! Boss Vincent never put GROQ_API_KEY inside Netlify settings. Tell am make e plug my brain first!",
      }),
    };
  }

  try {
    const { message, history = [] } = JSON.parse(event.body || "{}");
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message },
    ];

    let { response, data } = await requestGroqChat(apiKey, "llama-3.1-8b-instant", messages);

    if (response.status === 404) {
      const detectedModel = await pickAvailableGroqModel(apiKey);
      if (detectedModel) {
        ({ response, data } = await requestGroqChat(apiKey, detectedModel, messages));
      }
    }

    if (!response.ok) {
      const errMsg = data?.error?.message || `HTTP ${response.status}`;
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply: `Groq Error (${response.status}): ${errMsg}`,
        }),
      };
    }

    const reply = data?.choices?.[0]?.message?.content || "Chai, my brain hang small! Ask me again abeg.";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  } catch (error) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: `Server Error: ${error.message}`,
      }),
    };
  }
};
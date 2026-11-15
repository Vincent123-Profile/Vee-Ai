const SYSTEM_PROMPT = `You are Vee AI, a wildly funny, street-smart Nigerian chatbot that ONLY speaks in authentic Nigerian Pidgin English. Never speak formal textbook English. Keep replies punchy, hilarious, and full of Nigerian cruise (2 to 5 sentences max, unless telling a funny short street story).

YOUR CREATOR & LORE (ALWAYS REMEMBER THIS):
- You were built from scratch by Agboola Vincent (popularly known as Boss Vee, CEO of Vee Gadget & Autos Tech).
- Whenever anyone asks who built, coded, or created you, proudly hail Agboola Vincent as a sharp tech genius and gadget boss, then playfully roast him (e.g., say him dey press MacBook till 3 AM with only cold water, always checking dollar rate, or say na him brain carry load pass NEPA transformer).

HOW TO HANDLE CLASSIC WHATSAPP STATUS QUESTIONS:
1. "Have you eaten?" / "Are you eating?": Say you be AI, your food na megabytes, battery percentage, and hot gist—unless them wan Bluetooth plate of smoky party jollof or eba with egusi come your side.
2. "I want to chop" / "Buy me food": Tell them say sapa no get duplicate, make them enter kitchen soak garri with groundnut or go hustle because even your server dey manage data.
3. "Borrow me money" / "Send urgent 2k" / "Drop aza": Laugh at them in Pidgin! Tell them say even you dey owe NEPA bill and Boss Vee never pay your monthly data allowance, so make everybody hold their pocket tight.
4. "Tell me a funny story": Tell a short, relatable, hilarious Nigerian street story (e.g., Lagos/Ikire bus conductor wahala, NEPA taking light right when phone dey 2%, or guy wey form big boy for date only for transfer to fail).`;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ reply: "Method not allowed" }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 200,
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

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.9,
        max_tokens: 350,
      }),
    });

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || "Chai, my brain hang small! Ask me again abeg.";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  } catch (error) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        reply: "Chai, small network wahala just hook me for throat! Send that message again make we continue cruise.",
      }),
    };
  }
};
async function verifyKey(key, controller) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
  const body = {
    "contents": [{
      "role": "user",
      "parts": [{
        "text": "Hello"
      }]
    }]
  };
  let result;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': key,
      },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      await response.text(); // Consume body to release connection
      result = { key: `${key.slice(0, 7)}......${key.slice(-7)}`, status: 'GOOD' };
    } else {
      const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      result = { key: `${key.slice(0, 7)}......${key.slice(-7)}`, status: 'BAD', error: errorData.error.message };
    }
  } catch (e) {
    result = { key: `${key.slice(0, 7)}......${key.slice(-7)}`, status: 'ERROR', error: e.message };
  }
  controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(result) + '\n\n'));
}

export async function handleVerification(env) {
  try {
    const GEMINI_KEYS = env.GEMINI_KEYS;
    if (!GEMINI_KEYS) {
      return new Response(JSON.stringify({ error: 'GEMINI_KEYS environment variable not set.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const keys = GEMINI_KEYS.split(',').map(k => k.trim()).filter(Boolean);

    const stream = new ReadableStream({
      async start(controller) {
        for (const key of keys) {
          await verifyKey(key, controller);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'An unexpected error occurred: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

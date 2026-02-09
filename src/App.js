import './App.css';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

function App() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: ''
    }
  ]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const model = 'deepseek/deepseek-r1-0528:free';
  const systemPrompt = 'You are a helpful, concise assistant.';

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const updateLastAssistant = (chunk) => {
    flushSync(() => {
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (next[i].role === 'assistant') {
            next[i] = {
              ...next[i],
              content: `${next[i].content}${chunk}`
            };
            break;
          }
        }
        return next;
      });
    });
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) {
      return;
    }

    setInput('');
    setError('');
    setIsStreaming(true);
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '' }
    ]);

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const requestMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
          .filter((message) => message.content && message.content.trim())
          .map((message) => ({
            role: message.role,
            content: message.content
          })),
        { role: 'user', content: trimmed }
      ];

      const apiKey = process.env.REACT_APP_OPENROUTER_API_KEY;
      if (!apiKey) {
        setError('Missing REACT_APP_OPENROUTER_API_KEY in ui/.env');
        setIsStreaming(false);
        return;
      }

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: requestMessages,
          temperature: 0.7,
          max_tokens: 2048,
          top_p: 0.9
        }),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const lines = event.split('\n');
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('data:')) {
              dataLines.push(line.replace(/^data:\s*/, ''));
            }
          }
          if (!dataLines.length) {
            continue;
          }
          const data = dataLines.join('\n');
          if (data === '[DONE]') {
            continue;
          }
          const payload = JSON.parse(data);
          const delta = payload.choices?.[0]?.delta?.content;
          const full = payload.choices?.[0]?.message?.content;
          if (delta) {
            updateLastAssistant(delta);
          } else if (full) {
            updateLastAssistant(full);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError('Could not reach the OpenRouter API. Check your server and API key.');
        updateLastAssistant('\n\n[Error: Unable to connect to OpenRouter]');
      }
    } finally {
      setIsStreaming(false);
      controllerRef.current = null;
    }
  };

  const stopStreaming = () => {
    if (controllerRef.current) {
      controllerRef.current.abort();
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const renderInlineBold = (text) => {
    const parts = text.split('**');
    return parts.map((part, idx) =>
      idx % 2 === 1 ? <strong key={`b-${idx}`}>{part}</strong> : part
    );
  };

  const renderMessageContent = (text) => {
    const lines = text.split('\n');
    const blocks = [];
    let listBuffer = null;

    const flushList = () => {
      if (!listBuffer) return;
      blocks.push(listBuffer);
      listBuffer = null;
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      if (!trimmed) {
        flushList();
        blocks.push({ type: 'spacer', key: `sp-${idx}` });
        return;
      }

      if (trimmed.startsWith('### ')) {
        flushList();
        blocks.push({
          type: 'h3',
          key: `h3-${idx}`,
          text: trimmed.replace(/^###\s+/, '')
        });
        return;
      }
      if (trimmed.startsWith('## ')) {
        flushList();
        blocks.push({
          type: 'h2',
          key: `h2-${idx}`,
          text: trimmed.replace(/^##\s+/, '')
        });
        return;
      }
      if (trimmed.startsWith('# ')) {
        flushList();
        blocks.push({
          type: 'h1',
          key: `h1-${idx}`,
          text: trimmed.replace(/^#\s+/, '')
        });
        return;
      }

      const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
      if (orderedMatch) {
        if (!listBuffer || listBuffer.listType !== 'ol') {
          flushList();
          listBuffer = { type: 'list', listType: 'ol', items: [], key: `ol-${idx}` };
        }
        listBuffer.items.push(renderInlineBold(orderedMatch[2]));
        return;
      }

      const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
      if (bulletMatch) {
        if (!listBuffer || listBuffer.listType !== 'ul') {
          flushList();
          listBuffer = { type: 'list', listType: 'ul', items: [], key: `ul-${idx}` };
        }
        listBuffer.items.push(renderInlineBold(bulletMatch[1]));
        return;
      }

      flushList();
      blocks.push({
        type: 'p',
        key: `p-${idx}`,
        text: trimmed
      });
    });

    flushList();

    return blocks.map((block) => {
      if (block.type === 'spacer') {
        return <div key={block.key} className="line-spacer" />;
      }
      if (block.type === 'h1') {
        return <h1 key={block.key}>{renderInlineBold(block.text)}</h1>;
      }
      if (block.type === 'h2') {
        return <h2 key={block.key}>{renderInlineBold(block.text)}</h2>;
      }
      if (block.type === 'h3') {
        return <h3 key={block.key}>{renderInlineBold(block.text)}</h3>;
      }
      if (block.type === 'list') {
        const ListTag = block.listType === 'ol' ? 'ol' : 'ul';
        return (
          <ListTag key={block.key} className="message-list">
            {block.items.map((item, index) => (
              <li key={`${block.key}-${index}`}>{item}</li>
            ))}
          </ListTag>
        );
      }
      return <p key={block.key}>{renderInlineBold(block.text)}</p>;
    });
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark" />
          <div>
            <p className="eyebrow">DeepSeek</p>
            <h1>Studio Chat</h1>
          </div>
        </div>
        <div className="status-pill">
          <span className={`status-dot ${isStreaming ? 'live' : ''}`} />
          {isStreaming ? 'Streaming' : 'Idle'}
        </div>
      </header>

      <main className="workspace">
        <section className="chat-panel">
          {messages.length <= 1 ? (
            <div className="hero">
              <p className="hero-title">What can I help with?</p>
              <p className="hero-sub">
                Ask anything and get fast answers from DeepSeek.
              </p>
            </div>
          ) : null}

          {error ? <div className="card error-card">{error}</div> : null}

          <div className="chat-window">
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`bubble ${message.role}`}
              >
                <div className="content">{renderMessageContent(message.content)}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </section>

        <div className="composer">
          <div className="composer-shell">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Studio Chat..."
              rows={1}
            />
            <button
              className="send-button"
              type="button"
              onClick={sendMessage}
              disabled={!input.trim() || isStreaming}
              aria-label="Send message"
            >
              Send
            </button>
          </div>
          <div className="composer-actions">
            <span className="muted small">
              {isStreaming ? 'Generating response...' : 'Ready'}
            </span>
            <div className="action-row">
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setMessages([{ role: 'assistant', content: 'Conversation cleared.' }]);
                }}
              >
                Clear chat
              </button>
              <button
                className="ghost"
                type="button"
                onClick={stopStreaming}
                disabled={!isStreaming}
              >
                Stop
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;

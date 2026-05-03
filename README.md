# BookingAI

AI-powered booking SaaS that lets businesses automate appointment scheduling through a conversational Claude AI assistant.

## What it does

BookingAI provides a REST API that handles:
- Viewing available time slots
- Creating and confirming bookings
- Conversational AI booking via Claude (natural language → appointment confirmed)

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Set your Anthropic API key
cp .env.example .env
# Edit .env and add your key from https://console.anthropic.com

# 3. Start the server (set key inline or via .env loader)
ANTHROPIC_API_KEY=sk-ant-... npm start
```

The server runs on `http://localhost:3000` by default.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| GET | `/api/slots` | List all time slots |
| GET | `/api/bookings` | List all bookings |
| POST | `/api/bookings` | Create a booking directly |
| POST | `/api/chat` | Chat with the AI booking assistant |

### POST /api/chat — AI assistant

Send a message and optionally the conversation history. The assistant checks slots, collects customer info, and creates the booking — all through natural language.

**Request:**
```json
{
  "message": "I'd like to book an appointment for May 10th",
  "history": []
}
```

**Response:**
```json
{
  "reply": "I have two slots available on May 10th: 10:00 and 11:00. Which works for you?",
  "history": [...]
}
```

Pass the returned `history` array back on the next request to continue the conversation.

**Example conversation:**
```
User:  "I want to book an appointment"
AI:    "Sure! Here are the available times: [lists slots]. Which works for you?"
User:  "May 10th at 11am please"
AI:    "Great! Could I get your name and email?"
User:  "Maria Papadopoulou, maria@example.com"
AI:    "All set! Your appointment on May 10th at 11:00 is confirmed. Booking ID: 12345."
```

### POST /api/bookings — Direct booking

```json
{
  "name": "Maria Papadopoulou",
  "email": "maria@example.com",
  "slotId": 1
}
```

## Architecture

```
Client → POST /api/chat
           ↓
        Claude claude-opus-4-7
           ↓ tool_use
        get_available_slots()   → in-memory slot store
        create_booking()        → in-memory booking store
           ↓
        Natural language reply
```

Claude uses **tool use** to check availability and confirm bookings. The system prompt is **prompt-cached** so multi-turn conversations are fast and cheap.

## Roadmap

- [ ] Database integration (PostgreSQL)
- [ ] Email/SMS confirmation via Resend / Twilio
- [ ] Multi-tenant support
- [ ] Calendar sync (Google Calendar, Outlook)
- [ ] Streaming responses for real-time chat UI

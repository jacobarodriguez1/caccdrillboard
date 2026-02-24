# CACC Drill Board

A real-time drill management and roster system built with Next.js and TypeScript.

This application was designed to support drill coordination, roster tracking, and live state updates for structured training environments.

---

## 🚀 Overview

CACC Drill Board is a web-based platform that enables:

- Real-time board state updates
- Drill roster management
- Role-based access (Admin / Judge / Public views)
- Socket-based live synchronization
- Structured data handling via API routes

The system is designed to support organized training environments where visibility, timing, and structured control are critical.

---

## 🏗 Tech Stack

- **Next.js**
- **React**
- **TypeScript**
- **Node.js**
- **WebSockets**
- **REST API Routes**
- **ESLint**

---

## 📁 Project Structure

```
components/     → Reusable UI components  
lib/            → State logic, socket client, utilities  
pages/          → Application routes and API endpoints  
public/         → Static assets  
styles/         → Global styling  
data/           → Drill roster CSV data  
```

---

## 🔐 Role-Based Views

- **Public View** – Displays board state
- **Judge View** – Interaction layer for scoring or control
- **Admin View** – Authentication, roster reload, and board management

---

## 📡 API Endpoints

- `/api/state` – Returns current board state
- `/api/socket` – WebSocket connection handler
- `/api/admin-login`
- `/api/admin-logout`
- `/api/reload-roster`

---

## 💡 Purpose

This project demonstrates:

- Real-time state synchronization
- Modular architecture
- API route structuring
- Separation of concerns
- Controlled state management in a multi-role environment

---

## 🛠 Local Development

```bash
npm install
npm run dev
```

Visit:

```
http://localhost:3000
```

---

## 📈 Future Improvements

- Persistent database storage
- Authentication hardening
- Audit logging
- Deployment configuration (Vercel / Docker)
- Role permission refinement

---

## 👤 Author

Jacob A. Rodriguez  
Assistant S-3 (Training Officer), California Cadet Corps  
MBA – Organizational Leadership  

---


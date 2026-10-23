import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors({ origin: 'http://localhost:5173' })); 

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST'] },
});

interface DrawData {
  x: number;
  y: number;
  prevX: number | null;
  prevY: number | null;
  color: string;
  lineWidth: number;
  mode?: 'draw' | 'erase';
  roomId?: string;
  ownerId?: string;
  operationId?: string;
  roomId?: string;
}

interface ChatMessage {
  id: string;
  text: string;
  sender: string;
  time: string;
}

interface ShapeData {
  tool: 'line' | 'rectangle' | 'circle' | 'arrow';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  color: string;
  lineWidth: number;
  roomId?: string;
  ownerId?: string;
  operationId?: string;
}

// ตัวแปรนับจำนวนคนออนไลน์ในระบบ
const roomUsers = new Map<string, number>();
const roomPasswords = new Map<string, string>();
const rooms = new Set<string>(['main']);
const roomMembers = new Map<string, Map<string, string>>();
const pendingClearRequests = new Map<string, { requestId: string; requester: string; approvals: Set<string> }>();

const getRoomUserCount = (roomId: string) => roomUsers.get(roomId) ?? 0;
const emitRoomMembers = (roomId: string) => {
  const members = [...(roomMembers.get(roomId)?.values() ?? [])];
  io.to(roomId).emit('room_members_update', members);
};
const updateRoomUserCount = (roomId: string, change: number) => {
  const nextCount = Math.max(0, getRoomUserCount(roomId) + change);
  if (nextCount === 0) {
    roomUsers.delete(roomId);
    if (roomId !== 'main') {
      rooms.delete(roomId);
      roomPasswords.delete(roomId);
      console.log(`🧹 Room deleted because it is empty: ${roomId}`);
    }
  } else {
    roomUsers.set(roomId, nextCount);
  }
  emitRoomMembers(roomId);
  io.to(roomId).emit('user_count_update', nextCount);
};

const addRoomMember = (roomId: string, socketId: string, username: string) => {
  const members = roomMembers.get(roomId) ?? new Map<string, string>();
  members.set(socketId, username);
  roomMembers.set(roomId, members);
  emitRoomMembers(roomId);
};

const removeRoomMember = (roomId: string, socketId: string) => {
  const members = roomMembers.get(roomId);
  members?.delete(socketId);
  if (members && members.size === 0) roomMembers.delete(roomId);
  emitRoomMembers(roomId);
};

io.on('connection', (socket) => {
  socket.data.roomId = 'main';
  socket.data.username = `Guest-${socket.id.slice(0, 5)}`;
  socket.join('main');
  addRoomMember('main', socket.id, socket.data.username);
  updateRoomUserCount('main', 1);
  console.log(`⚡ User connected: ${socket.id}`);

  socket.on('join_room', (
    request: { roomId?: string; password?: string; action?: 'create' | 'join'; username?: string },
    acknowledge?: (response: { ok: boolean; error?: string }) => void,
  ) => {
    const nextRoomId = typeof request?.roomId === 'string' && request.roomId.trim()
      ? request.roomId.trim().slice(0, 64)
      : 'main';
    const password = typeof request?.password === 'string' ? request.password : '';
    const action = request?.action === 'join' ? 'join' : 'create';
    const username = typeof request?.username === 'string' && request.username.trim()
      ? request.username.trim().slice(0, 30)
      : `Guest-${socket.id.slice(0, 5)}`;
    const roomExists = rooms.has(nextRoomId);

    if (action === 'create' && roomExists && nextRoomId !== 'main') {
      acknowledge?.({ ok: false, error: 'Room ID นี้มีอยู่แล้ว กรุณาใช้ ID อื่นหรือเลือกเข้าร่วมห้อง' });
      return;
    }
    if (action === 'join' && !roomExists) {
      acknowledge?.({ ok: false, error: 'ไม่พบห้องนี้ กรุณาตรวจสอบ Room ID หรือสร้างห้องใหม่' });
      return;
    }
    if (roomPasswords.has(nextRoomId) && roomPasswords.get(nextRoomId) !== password) {
      acknowledge?.({ ok: false, error: 'รหัสผ่านห้องไม่ถูกต้อง' });
      return;
    }
    if (action === 'create') {
      rooms.add(nextRoomId);
      if (password) roomPasswords.set(nextRoomId, password);
    }
    const previousRoomId = socket.data.roomId as string;
    if (previousRoomId === nextRoomId) {
      socket.data.username = username;
      addRoomMember(nextRoomId, socket.id, username);
      acknowledge?.({ ok: true });
      return;
    }
    removeRoomMember(previousRoomId, socket.id);
    socket.leave(previousRoomId);
    updateRoomUserCount(previousRoomId, -1);
    socket.data.roomId = nextRoomId;
    socket.data.username = username;
    socket.join(nextRoomId);
    addRoomMember(nextRoomId, socket.id, username);
    updateRoomUserCount(nextRoomId, 1);
    acknowledge?.({ ok: true });
  });

  // 1. ส่งพิกัดวาดรูป
  socket.on('draw', (data: DrawData) => {
    const roomId = socket.data.roomId as string;
    socket.to(roomId).emit('draw', { ...data, ownerId: socket.id });
  });

  socket.on('shape', (data: ShapeData) => {
    const roomId = socket.data.roomId as string;
    if (data?.roomId && data.roomId !== roomId) return;
    socket.to(roomId).emit('shape', { ...data, ownerId: socket.id });
  });

  socket.on('text', (data: { x: number; y: number; text: string; color: string; lineWidth: number; roomId?: string }) => {
    const roomId = socket.data.roomId as string;
    if (data?.roomId !== roomId || typeof data.text !== 'string' || data.text.length > 500) return;
    socket.to(roomId).emit('text', { ...data, ownerId: socket.id });
  });

  socket.on('undo_operation', (data: { roomId?: string; operationId?: string }) => {
    const roomId = socket.data.roomId as string;
    if (data?.roomId !== roomId || typeof data.operationId !== 'string') return;
    socket.to(roomId).emit('undo_operation', { operationId: data.operationId, ownerId: socket.id });
  });

  socket.on('redo_operation', (data: { roomId?: string; operation?: Record<string, unknown> }) => {
    const roomId = socket.data.roomId as string;
    if (data?.roomId !== roomId || !data.operation) return;
    socket.to(roomId).emit('redo_operation', { ...data.operation, ownerId: socket.id });
  });

  socket.on('request_clear', (requestedRoomId?: string) => {
    const roomId = socket.data.roomId as string;
    if (requestedRoomId && requestedRoomId !== roomId) return;
    const requestId = `${socket.id}-${Date.now()}`;
    const requester = socket.data.username as string;
    pendingClearRequests.set(roomId, { requestId, requester, approvals: new Set() });
    io.to(roomId).emit('clear_confirmation_request', { requestId, requester });
  });

  socket.on('confirm_clear', (data: { roomId?: string; requestId?: string; approved?: boolean }) => {
    const roomId = socket.data.roomId as string;
    const pending = pendingClearRequests.get(roomId);
    if (!pending || data?.roomId !== roomId || data.requestId !== pending.requestId) return;
    if (!data.approved) {
      pendingClearRequests.delete(roomId);
      io.to(roomId).emit('clear_confirmation_cancelled');
      return;
    }
    pending.approvals.add(socket.id);
    const totalUsers = roomMembers.get(roomId)?.size ?? 0;
    io.to(roomId).emit('clear_confirmation_progress', { approved: pending.approvals.size, total: totalUsers });
    if (totalUsers > 0 && pending.approvals.size >= totalUsers) {
      pendingClearRequests.delete(roomId);
      io.to(roomId).emit('clear_canvas');
    }
  });

  socket.on('canvas_state', (payload: { roomId?: string; dataUrl?: string }) => {
    const roomId = socket.data.roomId as string;
    if (payload?.roomId !== roomId || typeof payload.dataUrl !== 'string' || payload.dataUrl.length > 5_000_000) return;
    socket.to(roomId).emit('canvas_state', payload.dataUrl);
  });

  // 3. 💬 ระบบส่งข้อความแชทสด
  socket.on('send_message', (messageData: ChatMessage) => {
    // ส่งข้อความไปให้ผู้ใช้คนอื่น ๆ ทุกคนในห้องแชท
    socket.to(socket.data.roomId as string).emit('receive_message', messageData);
  });

  // เมื่อผู้ใช้งานปิดเว็บหรือตัดการเชื่อมต่อ
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId as string;
    const pending = pendingClearRequests.get(roomId);
    if (pending?.requester === socket.data.username) {
      pendingClearRequests.delete(roomId);
      io.to(roomId).emit('clear_confirmation_cancelled');
    }
    removeRoomMember(roomId, socket.id);
    updateRoomUserCount(roomId, -1);
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Ultimate Real-time Server running on http://localhost:${PORT}`);
});

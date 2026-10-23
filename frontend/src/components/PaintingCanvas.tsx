import React, { useRef, useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';

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

interface TextData {
  x: number;
  y: number;
  text: string;
  color: string;
  lineWidth: number;
  roomId?: string;
  ownerId?: string;
  operationId?: string;
}

interface Operation {
  id: string;
  ownerId: string;
  type: 'stroke' | 'shape' | 'text';
  segments?: DrawData[];
  shape?: ShapeData;
  text?: TextData;
}

interface ChatMessage {
  id: string;
  text: string;
  sender: string;
  time: string;
}

const generateRoomId = () => `room-${Math.random().toString(36).slice(2, 8)}`;

export default function PaintingCanvas() {
  const inviteRoomId = new URLSearchParams(window.location.search).get('room')?.trim() || '';
  const savedSession = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('canvas-session') || 'null') as {
        username?: string;
        roomId?: string;
        roomPassword?: string;
        roomAction?: 'create' | 'join';
      } | null;
    } catch {
      return null;
    }
  })();
  const shouldPromptForInvite = Boolean(inviteRoomId && savedSession?.roomId !== inviteRoomId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const previewPixelsRef = useRef<ImageData | null>(null);
  const operationsRef = useRef<Operation[]>([]);
  const redoOperationsRef = useRef<Operation[]>([]);
  const activeSegmentsRef = useRef<DrawData[]>([]);
  const activeOperationIdRef = useRef<string>('');
  const clientIdRef = useRef(`user-${Math.random().toString(36).slice(2, 10)}`);
  const [roomId, setRoomId] = useState<string>(inviteRoomId || savedSession?.roomId || generateRoomId());
  const canvasSize = { width: 750, height: 500 };
  
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [color, setColor] = useState<string>('#000000');
  const [lineWidth, setLineWidth] = useState<number>(5);
  const [prevPos, setPrevPos] = useState<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<'draw' | 'erase'>('draw');
  const [activeTool, setActiveTool] = useState<'draw' | 'erase' | 'line' | 'rectangle' | 'circle' | 'arrow' | 'text'>('draw');
  const [operationVersion, setOperationVersion] = useState(0);

  // ✨ STATE ใหม่ที่เพิ่มเข้ามา
  const [userCount, setUserCount] = useState<number>(1); // จำนวนคนออนไลน์
  const [messages, setMessages] = useState<ChatMessage[]>([]); // กล่องข้อความ
  const [inputMessage, setInputMessage] = useState<string>(''); // ข้อความที่กำลังพิมพ์
  const [username, setUsername] = useState<string>(savedSession?.username || '');
  const [roomPassword, setRoomPassword] = useState<string>(savedSession?.roomPassword || '');
  const [roomAction, setRoomAction] = useState<'create' | 'join'>(inviteRoomId ? 'join' : (savedSession?.roomAction || (savedSession ? 'join' : 'create')));
  const [isJoined, setIsJoined] = useState<boolean>(Boolean(savedSession?.username && savedSession?.roomId && !shouldPromptForInvite));
  const [roomError, setRoomError] = useState<string>('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [clearRequest, setClearRequest] = useState<{ requestId: string; requester: string } | null>(null);
  const [clearProgress, setClearProgress] = useState<{ approved: number; total: number }>({ approved: 0, total: 0 });

  const saveCanvas = (canvas: HTMLCanvasElement) => {
    localStorage.setItem(`canvas:${roomId}`, canvas.toDataURL('image/png'));
  };

  const restoreCanvas = (dataUrl: string, broadcast = false) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const image = new Image();
    image.onload = () => {
      context.clearRect(0, 0, canvasSize.width, canvasSize.height);
      context.drawImage(image, 0, 0, canvasSize.width, canvasSize.height);
      saveCanvas(canvas);
    };
    image.src = dataUrl;
    if (broadcast) socketRef.current?.emit('canvas_state', { roomId, dataUrl });
  };

  const rememberCanvas = (canvas: HTMLCanvasElement) => {
    historyRef.current.push(canvas.toDataURL('image/png'));
    if (historyRef.current.length > 30) historyRef.current.shift();
    redoRef.current = [];
  };

  const drawShape = (context: CanvasRenderingContext2D, shape: ShapeData) => {
    const { startX, startY, endX, endY } = shape;
    const width = endX - startX;
    const height = endY - startY;
    context.beginPath();
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = shape.color;
    context.lineWidth = shape.lineWidth;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (shape.tool === 'line') {
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
    } else if (shape.tool === 'rectangle') {
      context.rect(startX, startY, width, height);
    } else if (shape.tool === 'circle') {
      const radius = Math.sqrt(width ** 2 + height ** 2);
      context.arc(startX, startY, radius, 0, Math.PI * 2);
    } else if (shape.tool === 'arrow') {
      const angle = Math.atan2(height, width);
      const headLength = Math.max(12, shape.lineWidth * 3);
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.moveTo(endX, endY);
      context.lineTo(endX - headLength * Math.cos(angle - Math.PI / 6), endY - headLength * Math.sin(angle - Math.PI / 6));
      context.moveTo(endX, endY);
      context.lineTo(endX - headLength * Math.cos(angle + Math.PI / 6), endY - headLength * Math.sin(angle + Math.PI / 6));
    }
    context.stroke();
  };

  const drawSegment = (context: CanvasRenderingContext2D, data: DrawData) => {
    context.beginPath();
    context.globalCompositeOperation = data.mode === 'erase' ? 'destination-out' : 'source-over';
    context.strokeStyle = data.color;
    context.lineWidth = data.lineWidth;
    context.moveTo(data.prevX ?? data.x, data.prevY ?? data.y);
    context.lineTo(data.x, data.y);
    context.stroke();
    context.globalCompositeOperation = 'source-over';
  };

  const redrawOperations = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    for (const operation of operationsRef.current) {
      if (operation.type === 'stroke') operation.segments?.forEach((segment) => drawSegment(context, segment));
      if (operation.type === 'shape' && operation.shape) drawShape(context, operation.shape);
      if (operation.type === 'text' && operation.text) {
        context.fillStyle = operation.text.color;
        context.font = `${Math.max(14, operation.text.lineWidth * 4)}px sans-serif`;
        context.fillText(operation.text.text, operation.text.x, operation.text.y);
      }
    }
    saveCanvas(canvas);
  };

  useEffect(() => {
    if (!isJoined || !roomId || !username.trim()) return;
    socketRef.current = io('http://localhost:3001');

    const canvas = canvasRef.current;
    if (!canvas) return;
    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * devicePixelRatio;
    canvas.height = canvasSize.height * devicePixelRatio;
    canvas.style.aspectRatio = `${canvasSize.width} / ${canvasSize.height}`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(devicePixelRatio, devicePixelRatio);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const savedCanvas = localStorage.getItem(`canvas:${roomId}`);
    if (savedCanvas) restoreCanvas(savedCanvas);
    historyRef.current = [canvas.toDataURL('image/png')];
    socketRef.current.emit('join_room', { roomId, password: roomPassword, username, action: roomAction }, (response: { ok: boolean; error?: string }) => {
      if (!response.ok) {
        setRoomError(response.error || 'ไม่สามารถเข้าห้องได้');
        setIsJoined(false);
        sessionStorage.removeItem('canvas-session');
        socketRef.current?.disconnect();
        return;
      }
      // หลังเข้าห้องสำเร็จ การ Refresh ครั้งต่อไปควรเป็นการเข้าร่วม
      // ไม่ใช่การสร้างห้องซ้ำ
      setRoomAction('join');
      sessionStorage.setItem('canvas-session', JSON.stringify({ username, roomId, roomPassword, roomAction: 'join' }));
    });

    // 🔌 รับข้อมูลวาดรูป
    socketRef.current.on('draw', (data: DrawData) => {
      drawSegment(context, data);
      const existingStroke = operationsRef.current.find((operation) => operation.id === data.operationId);
      if (existingStroke?.type === 'stroke') existingStroke.segments?.push(data);
      else operationsRef.current.push({ id: data.operationId || `remote-${Date.now()}-${Math.random()}`, ownerId: data.ownerId || 'remote', type: 'stroke', segments: [data] });
    });

    socketRef.current.on('shape', (shape: ShapeData) => {
      drawShape(context, shape);
      operationsRef.current.push({ id: shape.operationId || `remote-${Date.now()}-${Math.random()}`, ownerId: shape.ownerId || 'remote', type: 'shape', shape });
      saveCanvas(canvas);
    });

    socketRef.current.on('text', (data: TextData) => {
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = data.color;
      context.font = `${Math.max(14, data.lineWidth * 4)}px sans-serif`;
      context.fillText(data.text, data.x, data.y);
      operationsRef.current.push({ id: data.operationId || `remote-${Date.now()}-${Math.random()}`, ownerId: data.ownerId || 'remote', type: 'text', text: data });
      saveCanvas(canvas);
    });

    // 🧹 รับข้อมูลล้างกระดาน
    socketRef.current.on('clear_canvas', () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.clearRect(0, 0, canvasSize.width, canvasSize.height);
      operationsRef.current = [];
      redoOperationsRef.current = [];
      setClearRequest(null);
      setClearProgress({ approved: 0, total: 0 });
      saveCanvas(canvas);
    });

    socketRef.current.on('clear_confirmation_request', (request: { requestId: string; requester: string }) => {
      setClearRequest(request);
      setClearProgress({ approved: 0, total: 0 });
    });

    socketRef.current.on('clear_confirmation_progress', (progress: { approved: number; total: number }) => {
      setClearProgress(progress);
    });

    socketRef.current.on('clear_confirmation_cancelled', () => {
      setClearRequest(null);
      setClearProgress({ approved: 0, total: 0 });
    });

    socketRef.current.on('canvas_state', (dataUrl: string) => {
      restoreCanvas(dataUrl);
    });

    socketRef.current.on('undo_operation', ({ operationId }: { operationId: string }) => {
      operationsRef.current = operationsRef.current.filter((operation) => operation.id !== operationId);
      redrawOperations();
    });

    socketRef.current.on('redo_operation', (operation: Operation) => {
      if (!operationsRef.current.some((item) => item.id === operation.id)) {
        operationsRef.current.push(operation);
        redrawOperations();
      }
    });

    // 👥 1. อัปเดตยอดคนใช้ออนไลน์สด ๆ
    socketRef.current.on('user_count_update', (count: number) => {
      setUserCount(count);
    });

    socketRef.current.on('room_members_update', (members: string[]) => {
      setParticipants(members);
    });

    // 💬 2. รับข้อความแชทจากคนอื่น
    socketRef.current.on('receive_message', (msg: ChatMessage) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [isJoined, roomId]);

  // เลื่อนหน้าจอแชทลงมาด้านล่างสุดเวลามีข้อความใหม่
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleClearCanvas = () => {
    socketRef.current?.emit('request_clear', roomId);
  };

  const handleClearConfirmation = (approved: boolean) => {
    if (!clearRequest) return;
    socketRef.current?.emit('confirm_clear', { roomId, requestId: clearRequest.requestId, approved });
    if (!approved) setClearRequest(null);
  };

  const handleUndo = () => {
    const lastLocalIndex = operationsRef.current.map((operation) => operation.ownerId).lastIndexOf(clientIdRef.current);
    if (lastLocalIndex < 0) return;
    const [operation] = operationsRef.current.splice(lastLocalIndex, 1);
    redoOperationsRef.current.push(operation);
    socketRef.current?.emit('undo_operation', { roomId, operationId: operation.id });
    redrawOperations();
    setOperationVersion((version) => version + 1);
  };

  const handleRedo = () => {
    const next = redoOperationsRef.current.pop();
    if (!next) return;
    operationsRef.current.push(next);
    socketRef.current?.emit('redo_operation', { roomId, operation: next });
    redrawOperations();
    setOperationVersion((version) => version + 1);
  };

  // 💾 3. ฟังก์ชันบันทึกรูปภาพกระดานไวท์บอร์ด
  const handleDownloadImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const imageURL = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = imageURL;
    link.download = `whiteboard-${Date.now()}.png`;
    link.click();
  };

  // 💬 ฟังก์ชันส่งแชทออกไปหาเพื่อน
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;

    const newMsg: ChatMessage = {
      id: Math.random().toString(),
      text: inputMessage,
      sender: username,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages((prev) => [...prev, newMsg]); // เพิ่มในจอตัวเอง
    socketRef.current?.emit('send_message', newMsg); // ส่งหาเพื่อน
    setInputMessage('');
  };

  // แปลงตำแหน่งเมาส์ให้เป็นพิกัดจริงภายใน canvas
  // เพื่อป้องกันเส้นเหลื่อมเมื่อ canvas ถูกย่อด้วย CSS
  const getCanvasPosition = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvasSize.width / rect.width),
      y: (e.clientY - rect.top) * (canvasSize.height / rect.height),
    };
  };

  // Logic การวาดรูปปกติ
  const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const position = getCanvasPosition(e);
    if (!position) return;
    const canvas = canvasRef.current;
    if (canvas) rememberCanvas(canvas);
    const context = canvas?.getContext('2d');
    if (canvas && context) previewPixelsRef.current = context.getImageData(0, 0, canvas.width, canvas.height);
    activeSegmentsRef.current = [];
    activeOperationIdRef.current = `${clientIdRef.current}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setIsDrawing(true);
    setPrevPos(position);
  };

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !prevPos) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const position = getCanvasPosition(e);
    if (!position) return;
    const { x, y } = position;
    if (activeTool === 'text') return;
    if (activeTool !== 'draw' && activeTool !== 'erase') {
      if (previewPixelsRef.current) context.putImageData(previewPixelsRef.current, 0, 0);
      drawShape(context, { tool: activeTool, startX: prevPos.x, startY: prevPos.y, endX: x, endY: y, color, lineWidth });
      return;
    }

    const currentColor = activeTool === 'erase' ? 'rgba(0,0,0,1)' : color;

    context.beginPath();
    context.globalCompositeOperation = activeTool === 'erase' ? 'destination-out' : 'source-over';
    context.strokeStyle = currentColor;
    context.lineWidth = lineWidth;
    context.moveTo(prevPos.x, prevPos.y);
    context.lineTo(x, y);
    context.stroke();

    const segment: DrawData = { x, y, prevX: prevPos.x, prevY: prevPos.y, color: currentColor, lineWidth, mode: activeTool, roomId, ownerId: clientIdRef.current, operationId: activeOperationIdRef.current };
    activeSegmentsRef.current.push(segment);
    socketRef.current?.emit('draw', segment);
    setPrevPos({ x, y });
  };

  const stopDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const position = e ? getCanvasPosition(e) : prevPos;
    if (canvas && context && isDrawing && prevPos && activeTool !== 'draw' && activeTool !== 'erase') {
      if (position && activeTool !== 'text') {
        if (previewPixelsRef.current) context.putImageData(previewPixelsRef.current, 0, 0);
        const shape = { tool: activeTool, startX: prevPos.x, startY: prevPos.y, endX: position.x, endY: position.y, color, lineWidth, roomId, ownerId: clientIdRef.current, operationId: activeOperationIdRef.current } as ShapeData;
        drawShape(context, shape);
        operationsRef.current.push({ id: activeOperationIdRef.current, ownerId: clientIdRef.current, type: 'shape', shape });
        redoOperationsRef.current = [];
        socketRef.current?.emit('shape', { ...shape, roomId });
      }
      if (activeTool === 'text' && e && position) {
        const text = window.prompt('พิมพ์ข้อความบนกระดาน');
        if (text?.trim()) {
          const textData: TextData = { x: position.x, y: position.y, text: text.trim(), color, lineWidth, roomId, ownerId: clientIdRef.current, operationId: activeOperationIdRef.current };
          context.fillStyle = color;
          context.font = `${Math.max(14, lineWidth * 4)}px sans-serif`;
          context.fillText(textData.text, textData.x, textData.y);
          operationsRef.current.push({ id: activeOperationIdRef.current, ownerId: clientIdRef.current, type: 'text', text: textData });
          redoOperationsRef.current = [];
          socketRef.current?.emit('text', textData);
        }
      }
    }
    if ((activeTool === 'draw' || activeTool === 'erase') && activeSegmentsRef.current.length > 0) {
      operationsRef.current.push({ id: activeOperationIdRef.current, ownerId: clientIdRef.current, type: 'stroke', segments: [...activeSegmentsRef.current] });
      redoOperationsRef.current = [];
    }
    if (canvas) saveCanvas(canvas);
    setOperationVersion((version) => version + 1);
    previewPixelsRef.current = null;
    activeSegmentsRef.current = [];
    setIsDrawing(false);
    setPrevPos(null);
  };

  const handleRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUsername = username.trim();
    const cleanRoomId = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!cleanUsername || !cleanRoomId) {
      setRoomError('กรุณากรอกชื่อผู้ใช้และ Room ID');
      return;
    }
    setUsername(cleanUsername);
    setRoomId(cleanRoomId);
    setRoomError('');
    sessionStorage.setItem('canvas-session', JSON.stringify({
      username: cleanUsername,
      roomId: cleanRoomId,
      roomPassword,
      roomAction,
    }));
    window.history.replaceState(null, '', `?room=${encodeURIComponent(cleanRoomId)}`);
    setIsJoined(true);
  };

  const handleLeaveRoom = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    sessionStorage.removeItem('canvas-session');
    setIsDrawing(false);
    setPrevPos(null);
    setRoomError('');
    setRoomPassword('');
    setRoomAction('create');
    setRoomId('');
    setIsJoined(false);
    window.history.replaceState(null, '', window.location.pathname);
  };

  const handleCopyRoomLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // Clipboard API อาจถูกปิดในบาง Browser หรือบางสภาพแวดล้อม
    }
  };

  if (!isJoined) {
    return (
      <main className="room-lobby">
        <div className="room-card">
          <div className="brand-mark">✦</div>
          <p className="eyebrow">REAL-TIME CANVAS</p>
          <h1>เริ่มวาดไปด้วยกัน</h1>
          <p className="lobby-subtitle">สร้างห้องใหม่หรือเข้าร่วมห้องของทีม</p>
          <div className="room-tabs">
            <button type="button" className={roomAction === 'create' ? 'active' : ''} onClick={() => { setRoomAction('create'); setRoomId(generateRoomId()); }}>สร้างห้อง</button>
            <button type="button" className={roomAction === 'join' ? 'active' : ''} onClick={() => { setRoomAction('join'); setRoomId(''); }}>เข้าร่วมห้อง</button>
          </div>
          <form onSubmit={handleRoomSubmit} className="room-form">
            <label>ชื่อผู้ใช้<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="เช่น Frank" maxLength={30} autoFocus /></label>
            <label>Room ID {roomAction === 'create' && <span>(ระบบสร้างให้อัตโนมัติ)</span>}<input value={roomId} readOnly={roomAction === 'create'} onChange={(e) => setRoomId(e.target.value)} placeholder={roomAction === 'create' ? 'ระบบจะสร้าง ID ให้' : 'กรอก ID ห้อง'} maxLength={64} /></label>
            <label>รหัสผ่าน <span>(ไม่บังคับ)</span><input type="password" value={roomPassword} onChange={(e) => setRoomPassword(e.target.value)} placeholder={roomAction === 'create' ? 'เว้นว่างเพื่อสร้างห้องสาธารณะ' : 'กรอกรหัสผ่านถ้าห้องมีการป้องกัน'} maxLength={100} /></label>
            {roomError && <p className="room-error">{roomError}</p>}
            <button className="room-submit" type="submit">{roomAction === 'create' ? 'สร้างห้องและเริ่มวาด' : 'เข้าร่วมห้อง'}</button>
          </form>
          <p className="lobby-note">ห้องที่ไม่ใส่รหัสผ่านจะเป็นห้องสาธารณะ</p>
        </div>
      </main>
    );
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '1100px', margin: '0 auto' }}>
      
      {/* ส่วนหัวแสดงชื่อระบบ และ จำนวนคนออนไลน์แบบเท่ ๆ */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <div>
          <h2 style={{ margin: 0 }}>🎨 Ultimate Real-time Whiteboard</h2>
          <small style={{ color: '#666' }}>คุณใช้ชื่อ: <b>{username}</b></small>
          <small className="room-id-display">Room ID: <b>{roomId}</b> <button type="button" className="copy-room-button" onClick={handleCopyRoomLink}>คัดลอกลิงก์</button></small>
        </div>
        <div style={{ backgroundColor: '#e6f7ff', border: '1px solid #91d5ff', padding: '6px 12px', borderRadius: '20px', fontSize: '14px', color: '#0050b3', fontWeight: 'bold' }}>
          🟢 ออนไลน์อยู่: {userCount} คน
          <button type="button" className="leave-room-button" onClick={handleLeaveRoom}>ออกจากห้อง</button>
        </div>
      </div>
      
      {/* แถบเครื่องมือควบคุมการวาด */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '15px', alignItems: 'center', backgroundColor: '#fff', padding: '10px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
        <div style={{ display: 'flex', border: '1px solid #ccc', borderRadius: '4px', overflow: 'hidden' }}>
          <button onClick={() => { setMode('draw'); setActiveTool('draw'); }} style={{ padding: '6px 12px', backgroundColor: activeTool === 'draw' ? '#007bff' : '#fff', color: activeTool === 'draw' ? '#fff' : '#333', border: 'none', cursor: 'pointer' }}>✏️ พู่กัน</button>
          <button onClick={() => { setMode('erase'); setActiveTool('erase'); }} style={{ padding: '6px 12px', backgroundColor: activeTool === 'erase' ? '#007bff' : '#fff', color: activeTool === 'erase' ? '#fff' : '#333', border: 'none', cursor: 'pointer' }}>🧽 ยางลบ</button>
        </div>

        <div className="shape-tools" role="toolbar" aria-label="เครื่องมือรูปทรง">
          {([['line', '╱', 'เส้นตรง'], ['rectangle', '□', 'สี่เหลี่ยม'], ['circle', '○', 'วงกลม'], ['arrow', '➜', 'ลูกศร'], ['text', 'T', 'ข้อความ']] as const).map(([tool, icon, label]) => (
            <button key={tool} type="button" className={activeTool === tool ? 'shape-tool active' : 'shape-tool'} onClick={() => setActiveTool(tool)} title={label}>{icon}</button>
          ))}
        </div>

        {mode === 'draw' && (
          <label style={{ fontSize: '14px' }}> สี: <input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
        )}
        
        <label style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '5px' }}>
          ขนาด: <input type="range" min="1" max="50" value={lineWidth} onChange={(e) => setLineWidth(Number(e.target.value))} />
          <span>{lineWidth}px</span>
        </label>
        
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          <button onClick={handleUndo} disabled={operationVersion < 0 || !operationsRef.current.some((operation) => operation.ownerId === clientIdRef.current)}>↶ Undo</button>
          <button onClick={handleRedo} disabled={redoOperationsRef.current.length === 0}>↷ Redo</button>
          <button onClick={handleDownloadImage} style={{ padding: '6px 12px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>💾 เซฟรูปภาพ</button>
          <button onClick={handleClearCanvas} style={{ padding: '6px 12px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>🗑️ ล้างกระดาน</button>
        </div>
      </div>

      {/* พื้นที่หลัก: แบ่งออกเป็นฝั่งกระดาน (ซ้าย) และห้องแชท (ขวา) */}
      <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={startDrawing}
          onPointerMove={draw}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
          style={{ border: '2px solid #333', backgroundColor: '#ffffff', cursor: mode === 'erase' ? 'cell' : 'crosshair', borderRadius: '8px', boxShadow: '0 4px 10px rgba(0,0,0,0.08)' }}
        />

        {/* 💬 กล่องห้องแชทข้างกระดาน */}
        <div style={{ width: '300px', height: '504px', display: 'flex', flexDirection: 'column', border: '2px solid #333', borderRadius: '8px', backgroundColor: '#fff', boxShadow: '0 4px 10px rgba(0,0,0,0.08)' }}>
          <div style={{ backgroundColor: '#333', color: '#fff', padding: '10px', fontWeight: 'bold', borderTopLeftRadius: '5px', borderTopRightRadius: '5px', textAlign: 'center' }}>💬 Live Chat Room</div>
          <div className="participants-strip">
            <span className="participants-label">ในห้องนี้</span>
            <div className="participant-list">
              {participants.map((member, index) => <span className="participant-chip" key={`${member}-${index}`} title={member}>{member}</span>)}
            </div>
          </div>
          
          {/* พื้นที่แสดงข้อความ */}
          <div style={{ flex: 1, padding: '10px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', backgroundColor: '#fafafa' }}>
            {messages.map((msg) => (
              <div key={msg.id} style={{ alignSelf: msg.sender === username ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{ fontSize: '10px', color: '#888', marginBottom: '2px', textAlign: msg.sender === username ? 'right' : 'left' }}>{msg.sender} ({msg.time})</div>
                <div style={{ backgroundColor: msg.sender === username ? '#dcf8c6' : '#fff', border: '1px solid #ddd', padding: '8px 12px', borderRadius: '8px', fontSize: '14px', wordBreak: 'break-word' }}>{msg.text}</div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* ฟอร์มการพิมพ์ส่งข้อความ */}
          <form onSubmit={handleSendMessage} style={{ display: 'flex', borderTop: '1px solid #ddd', padding: '8px' }}>
            <input type="text" value={inputMessage} onChange={(e) => setInputMessage(e.target.value)} placeholder="พิมพ์ข้อความคุยกัน..." style={{ flex: 1, padding: '8px', border: '1px solid #ccc', borderRadius: '4px', marginRight: '6px', fontSize: '14px' }} />
            <button type="submit" style={{ padding: '8px 14px', backgroundColor: '#007bff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>ส่ง</button>
          </form>
        </div>
      </div>

      {clearRequest && (
        <div className="clear-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="clear-confirm-title">
          <div className="clear-confirm-card">
            <div className="clear-confirm-icon">⚠</div>
            <h3 id="clear-confirm-title">ยืนยันการล้างกระดาน</h3>
            <p><b>{clearRequest.requester}</b> ต้องการล้างกระดาน ทุกคนในห้องต้องยืนยันก่อนดำเนินการ</p>
            <p className="clear-progress">ยืนยันแล้ว {clearProgress.approved} / {clearProgress.total || participants.length} คน</p>
            <div className="clear-confirm-actions">
              <button type="button" className="clear-cancel-button" onClick={() => handleClearConfirmation(false)}>ยกเลิก</button>
              <button type="button" className="clear-approve-button" onClick={() => handleClearConfirmation(true)}>ยืนยันล้างกระดาน</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

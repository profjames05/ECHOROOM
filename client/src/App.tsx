import { Bell, LogIn, MessageSquareText, Mic, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { io, type Socket } from 'socket.io-client'
import { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import './App.css'

type Room = {
  id: string
  title: string
  description: string
  host: string
  category: string
  listeners: number
  speakers: string[]
  live: boolean
  status?: string
}

type Discussion = {
  id: string
  title: string
  content?: string
  author: string
  category: string
  comments: number
  reactions: number
}

type DiscussionComment = {
  id: string
  content: string
  createdAt: string
  user: { id: string; username: string; fullName: string }
}

type NotificationItem = {
  id: string
  type: string
  title: string
  message: string
  read: boolean
}

type UserProfile = {
  id: string
  fullName: string
  username: string
  email: string
  role: string
}

type ChatMessage = {
  id: string
  roomId: string
  content: string
  createdAt: string
  user: { id: string; username: string; fullName: string }
}

type AdminStats = {
  users: number
  activeUsers: number
  rooms: number
  activeRooms: number
  discussions: number
  highlights: number
  reports: number
  feedback: number
}

type AdminOverview = {
  rooms: Room[]
  members: Array<{ id: string; fullName: string; username: string; email: string; role: string; status: string; createdAt: string }>
  reports: Array<{ id: string; reason: string; status: string; entityType: string; createdAt: string }>
  feedback: Array<{ id: string; subject: string; category: string; status: string; createdAt: string }>
}

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '')
const TOKEN_KEY = 'echoRoomToken'
const roomStatusLabel = (room: Room) => room.status === 'SCHEDULED' ? 'UPCOMING' : room.live ? 'LIVE' : 'ENDED'
const roomStatusClass = (room: Room) => room.live ? 'live-badge live' : room.status === 'SCHEDULED' ? 'live-badge upcoming' : 'live-badge'

async function fetchJson<T>(path: string, method = 'GET', body?: Record<string, unknown>) {
  const token = localStorage.getItem(TOKEN_KEY)
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}))
    throw new Error(errorBody.message ?? 'Request failed.')
  }

  return (await response.json()) as T
}

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [activeRoom, setActiveRoom] = useState<Room | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [commentThreads, setCommentThreads] = useState<Record<string, DiscussionComment[]>>({})
  const [openDiscussionId, setOpenDiscussionId] = useState<string | null>(null)
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [reactedDiscussions, setReactedDiscussions] = useState<Record<string, boolean>>({})
  const [messageDraft, setMessageDraft] = useState('')
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [remoteStreams, setRemoteStreams] = useState<Array<{ peerId: string; stream: MediaStream }>>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [discussions, setDiscussions] = useState<Discussion[]>([])
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [status, setStatus] = useState('Ready to launch the next live room.')
  const [joinMessage, setJoinMessage] = useState('')
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  const [registerForm, setRegisterForm] = useState({ fullName: '', email: '', password: '' })
  const [roomForm, setRoomForm] = useState({ title: '', description: '', category: 'Technology' })
  const [discussionForm, setDiscussionForm] = useState({ title: '', content: '', category: 'Technology' })
  const [feedbackForm, setFeedbackForm] = useState({ category: 'Product', subject: '', description: '', rating: '5' })
  const socketRef = useRef<Socket | null>(null)
  const activeRoomRef = useRef<Room | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>())

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications],
  )

  const loadDashboard = useEffectEvent(async () => {
    try {
      const [roomResponse, discussionResponse] = await Promise.all([
        fetchJson<{ rooms: Room[]; total: number }>('/api/rooms'),
        fetchJson<{ discussions: Discussion[]; total: number }>('/api/discussions'),
      ])
      startTransition(() => {
        setRooms(roomResponse.rooms)
        setDiscussions(discussionResponse.discussions)
      })

      if (!token) {
        startTransition(() => {
          setNotifications([])
          setStats(null)
          setProfile(null)
          setAdminOverview(null)
        })
        return
      }

      const profileResponse = await fetchJson<UserProfile>('/api/auth/me')
      const notificationResponse = await fetchJson<{ notifications: NotificationItem[]; total: number }>('/api/notifications')
      let dashboardStats: AdminStats | null = null
      let dashboardOverview: AdminOverview | null = null
      if (profileResponse.role === 'ADMIN') {
        [dashboardStats, dashboardOverview] = await Promise.all([
          fetchJson<AdminStats>('/api/admin/dashboard'),
          fetchJson<AdminOverview>('/api/admin/overview'),
        ])
      }
      startTransition(() => {
        setProfile(profileResponse)
        setNotifications(notificationResponse.notifications)
        setStats(dashboardStats)
        setAdminOverview(dashboardOverview)
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('session')) {
        localStorage.removeItem(TOKEN_KEY)
        startTransition(() => {
          setToken(null)
          setProfile(null)
          setNotifications([])
          setAdminOverview(null)
          setActiveTab('home')
        })
      }
      startTransition(() => setStatus(error instanceof Error ? error.message : 'Unable to load live dashboard data.'))
    }
  })

  useEffect(() => {
    void loadDashboard()
  }, [token])

  useEffect(() => {
    if (!token) return

    const socket = io(API_BASE, { auth: { token } })
    socketRef.current = socket
    const peerConnections = peerConnectionsRef.current
    const createPeerConnection = (peerId: string) => {
      const existing = peerConnectionsRef.current.get(peerId)
      if (existing) return existing

      const connection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      })
      peerConnectionsRef.current.set(peerId, connection)
      localStreamRef.current?.getTracks().forEach((track) => {
        connection.addTrack(track, localStreamRef.current as MediaStream)
      })
      connection.onicecandidate = (event) => {
        const roomId = activeRoomRef.current?.id
        if (event.candidate && roomId) {
          socket.emit('voice:ice-candidate', { roomId, targetId: peerId, candidate: event.candidate.toJSON() })
        }
      }
      connection.ontrack = (event) => {
        const stream = event.streams[0]
        if (stream) {
          setRemoteStreams((current) => [
            ...current.filter((entry) => entry.peerId !== peerId),
            { peerId, stream },
          ])
        }
      }
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
          connection.close()
          peerConnectionsRef.current.delete(peerId)
          setRemoteStreams((current) => current.filter((entry) => entry.peerId !== peerId))
        }
      }
      connection.onnegotiationneeded = async () => {
        const roomId = activeRoomRef.current?.id
        if (!roomId || connection.signalingState !== 'stable') return
        try {
          await connection.setLocalDescription(await connection.createOffer())
          socket.emit('voice:offer', { roomId, targetId: peerId, description: connection.localDescription })
        } catch {
          setStatus('Could not establish an audio connection with a room participant.')
        }
      }
      return connection
    }

    socket.on('chat:message', (message: ChatMessage) => {
      if (activeRoomRef.current?.id === message.roomId) {
        setChatMessages((current) => current.some((entry) => entry.id === message.id) ? current : [...current, message])
      }
    })
    socket.on('voice:peer-joined', ({ peerId }: { peerId: string }) => {
      createPeerConnection(peerId)
    })
    socket.on('voice:peers', (peerIds: string[]) => {
      peerIds.forEach((peerId) => createPeerConnection(peerId))
    })
    socket.on('voice:offer', async ({ from, description }: { from: string; description: RTCSessionDescriptionInit }) => {
      const connection = createPeerConnection(from)
      try {
        if (connection.signalingState !== 'stable') {
          await connection.setLocalDescription({ type: 'rollback' })
        }
        await connection.setRemoteDescription(description)
        const pending = pendingCandidatesRef.current.get(from) ?? []
        for (const candidate of pending) await connection.addIceCandidate(candidate)
        pendingCandidatesRef.current.delete(from)
        await connection.setLocalDescription(await connection.createAnswer())
        socket.emit('voice:answer', {
          roomId: activeRoomRef.current?.id,
          targetId: from,
          description: connection.localDescription,
        })
      } catch {
        setStatus('A room audio connection could not be negotiated.')
      }
    })
    socket.on('voice:answer', async ({ from, description }: { from: string; description: RTCSessionDescriptionInit }) => {
      const connection = peerConnectionsRef.current.get(from)
      if (connection && connection.signalingState === 'have-local-offer') {
        await connection.setRemoteDescription(description)
        const pending = pendingCandidatesRef.current.get(from) ?? []
        for (const candidate of pending) await connection.addIceCandidate(candidate)
        pendingCandidatesRef.current.delete(from)
      }
    })
    socket.on('voice:ice-candidate', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const connection = peerConnectionsRef.current.get(from)
      if (connection?.remoteDescription) {
        await connection.addIceCandidate(candidate).catch(() => undefined)
      } else {
        pendingCandidatesRef.current.set(from, [...(pendingCandidatesRef.current.get(from) ?? []), candidate])
      }
    })
    socket.on('room:participant-left', ({ userId }: { userId: string }) => {
      const connection = peerConnectionsRef.current.get(userId)
      connection?.close()
      peerConnectionsRef.current.delete(userId)
    })
    socket.on('connect_error', () => setStatus('Live room connection unavailable. Check that the API server is running.'))

    return () => {
      socket.disconnect()
      socketRef.current = null
      peerConnections.forEach((connection) => connection.close())
      peerConnections.clear()
      const localStream = localStreamRef.current
      localStream?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }
  }, [token])

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    try {
      const response = await fetchJson<{ message: string; user: UserProfile; token: string }>(
        '/api/auth/login',
        'POST',
        loginForm,
      )

      localStorage.setItem(TOKEN_KEY, response.token)
      setToken(response.token)
      setProfile(response.user)
      setStatus(response.message)
      setActiveTab('overview')
      setAuthMode(null)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Login failed.')
    }
  }

  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    try {
      const response = await fetchJson<{ message: string; user: UserProfile; token: string }>(
        '/api/auth/register',
        'POST',
        registerForm,
      )
      localStorage.setItem(TOKEN_KEY, response.token)
      setToken(response.token)
      setProfile(response.user)
      setStatus(response.message)
      setActiveTab('overview')
      setAuthMode(null)
      setRegisterForm({ fullName: '', email: '', password: '' })
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Registration failed.')
    }
  }

  const handleJoinRoom = async (roomId: string, displayName: string) => {
    if (!token) {
      setAuthMode('login')
      setStatus('Sign in to join the conversation.')
      return
    }

    try {
      const response = await fetchJson<{ message: string }>(`/api/rooms/${roomId}/join`, 'POST', { displayName })
      setJoinMessage(response.message)
      setStatus(response.message)
      const [roomResponse, messageResponse] = await Promise.all([
        fetchJson<{ room: Room }>(`/api/rooms/${roomId}`),
        fetchJson<{ messages: ChatMessage[] }>(`/api/rooms/${roomId}/messages`),
      ])
      activeRoomRef.current = roomResponse.room
      setActiveRoom(roomResponse.room)
      setChatMessages(messageResponse.messages)
      socketRef.current?.emit('room:join', roomId)
      setMicrophoneEnabled(false)
      setRemoteStreams([])
      setActiveTab('rooms')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to join room.')
    }
  }

  const handleLeaveRoom = async () => {
    if (!activeRoom) return
    const roomId = activeRoom.id
    try {
      await fetchJson<{ message: string }>(`/api/rooms/${roomId}/leave`, 'POST')
      socketRef.current?.emit('room:leave', roomId)
      peerConnectionsRef.current.forEach((connection) => connection.close())
      peerConnectionsRef.current.clear()
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
      setMicrophoneEnabled(false)
      setRemoteStreams([])
      setActiveRoom(null)
      activeRoomRef.current = null
      setChatMessages([])
      setStatus('You left the room.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to leave room.')
    }
  }

  const handleToggleMicrophone = async () => {
    if (localStreamRef.current) {
      const enabled = !microphoneEnabled
      localStreamRef.current.getAudioTracks().forEach((track) => { track.enabled = enabled })
      setMicrophoneEnabled(enabled)
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      localStreamRef.current = stream
      peerConnectionsRef.current.forEach((connection) => {
        stream.getTracks().forEach((track) => connection.addTrack(track, stream))
      })
      setMicrophoneEnabled(true)
      setStatus('Microphone connected to the room.')
    } catch {
      setStatus('Microphone access was not granted. Check your browser permissions and try again.')
    }
  }

  const handleSendMessage = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = messageDraft.trim()
    if (!activeRoom || !content || !socketRef.current?.connected) return
    socketRef.current.emit('chat:message', { roomId: activeRoom.id, content })
    setMessageDraft('')
  }

  const handleSpeakerRequest = async () => {
    if (!activeRoom) return
    try {
      await fetchJson<{ request: { id: string } }>(`/api/rooms/${activeRoom.id}/speaker-requests`, 'POST')
      setStatus('Your request to speak has been sent to the room host.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to request the speaker role.')
    }
  }

  const handleMarkRead = async (notificationId: string) => {
    try {
      await fetchJson<{ message: string }>(`/api/notifications/${notificationId}/read`, 'POST')
      setNotifications((current) =>
        current.map((notification) =>
          notification.id === notificationId ? { ...notification, read: true } : notification,
        ),
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to update notification.')
    }
  }

  const handleCreateRoom = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      const response = await fetchJson<{ room: Room }>('/api/rooms', 'POST', roomForm)
      setRooms((current) => [response.room, ...current])
      setRoomForm({ title: '', description: '', category: 'Technology' })
      setStatus(`Your room “${response.room.title}” is live.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to create room.')
    }
  }

  const handleCreateDiscussion = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      const response = await fetchJson<{ discussion: Discussion }>('/api/discussions', 'POST', discussionForm)
      setDiscussions((current) => [response.discussion, ...current])
      setDiscussionForm({ title: '', content: '', category: 'Technology' })
      setStatus('Your discussion has been published.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to publish discussion.')
    }
  }

  const handleToggleComments = async (discussionId: string) => {
    if (openDiscussionId === discussionId) {
      setOpenDiscussionId(null)
      return
    }
    try {
      const response = await fetchJson<{ comments: DiscussionComment[] }>(`/api/discussions/${discussionId}/comments`)
      setCommentThreads((current) => ({ ...current, [discussionId]: response.comments }))
      setOpenDiscussionId(discussionId)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to load comments.')
    }
  }

  const handleCreateComment = async (discussionId: string, event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = commentDrafts[discussionId]?.trim()
    if (!content) return
    try {
      const response = await fetchJson<{ comment: DiscussionComment }>(`/api/discussions/${discussionId}/comments`, 'POST', { content })
      setCommentThreads((current) => ({
        ...current,
        [discussionId]: [...(current[discussionId] ?? []), response.comment],
      }))
      setDiscussions((current) => current.map((discussion) =>
        discussion.id === discussionId ? { ...discussion, comments: discussion.comments + 1 } : discussion,
      ))
      setCommentDrafts((current) => ({ ...current, [discussionId]: '' }))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to publish comment.')
    }
  }

  const handleToggleReaction = async (discussionId: string) => {
    try {
      const response = await fetchJson<{ reacted: boolean; reactions: number }>(`/api/discussions/${discussionId}/reactions`, 'POST')
      setReactedDiscussions((current) => ({ ...current, [discussionId]: response.reacted }))
      setDiscussions((current) => current.map((discussion) =>
        discussion.id === discussionId ? { ...discussion, reactions: response.reactions } : discussion,
      ))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to react to discussion.')
    }
  }

  const handleSubmitFeedback = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      await fetchJson('/api/feedback', 'POST', { ...feedbackForm, rating: Number(feedbackForm.rating) })
      setFeedbackForm({ category: 'Product', subject: '', description: '', rating: '5' })
      setStatus('Thanks, your feedback has been submitted.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to submit feedback.')
    }
  }

  const handleEndRoom = async (roomId: string) => {
    try {
      await fetchJson(`/api/admin/rooms/${roomId}/end`, 'PATCH')
      setAdminOverview((current) => current ? {
        ...current,
        rooms: current.rooms.map((room) => room.id === roomId ? { ...room, live: false, status: 'ENDED' } : room),
      } : current)
      setRooms((current) => current.filter((room) => room.id !== roomId))
      setStats((current) => current ? { ...current, activeRooms: Math.max(0, current.activeRooms - 1) } : current)
      setStatus('Room ended by an administrator.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to end this room.')
    }
  }

  const handleResolveReport = async (reportId: string) => {
    try {
      await fetchJson(`/api/admin/reports/${reportId}/resolve`, 'PATCH')
      setAdminOverview((current) => current ? {
        ...current,
        reports: current.reports.map((report) => report.id === reportId ? { ...report, status: 'RESOLVED' } : report),
      } : current)
      setStatus('Report marked as resolved.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to resolve this report.')
    }
  }

  const handleSignOut = () => {
    socketRef.current?.disconnect()
    peerConnectionsRef.current.forEach((connection) => connection.close())
    peerConnectionsRef.current.clear()
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    setActiveRoom(null)
    activeRoomRef.current = null
    setChatMessages([])
    setRemoteStreams([])
    setMicrophoneEnabled(false)
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setProfile(null)
    setNotifications([])
    setStats(null)
    setAdminOverview(null)
    setActiveTab('home')
    setStatus('You have signed out.')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button type="button" className="brand-wrap brand-home" onClick={() => setActiveTab('home')}>
          <div className="brand-mark">E</div>
          <div>
            <p className="eyebrow">VOICE, IN GOOD COMPANY</p>
            <h1>ECHOROOM</h1>
          </div>
        </button>

        <nav className="nav-pills" aria-label="Main navigation">
          {[
            ...(profile ? ['overview', 'rooms', 'discussions', 'notifications', 'feedback'] : ['home', 'about', 'pricing', 'rooms']),
            ...(profile?.role === 'ADMIN' ? ['admin'] : []),
          ].map((tab) => (
            <button
              key={tab}
              type="button"
              className={activeTab === tab ? 'nav-pill active' : 'nav-pill'}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'overview' ? 'Dashboard' : tab === 'admin' ? 'Admin' : tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>

        <div className="header-actions">
          {profile ? (
            <>
              <button type="button" className="icon-button" aria-label="Notifications" onClick={() => setActiveTab('notifications')}>
                <Bell size={17} />
                {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
              </button>
              <button type="button" className="profile-compact" onClick={handleSignOut} title="Sign out">
                {profile.username} · Sign out
              </button>
            </>
          ) : (
            <>
              <button type="button" className="text-action" onClick={() => setAuthMode('login')}>Sign in</button>
              <button type="button" className="primary-btn header-cta" onClick={() => setAuthMode('register')}>Get started</button>
            </>
          )}
        </div>
      </header>

      {authMode && (
        <div className="auth-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthMode(null) }}>
          <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <div className="auth-modal-heading">
              <div>
                <p className="eyebrow">ECHOROOM ACCOUNT</p>
                <h2 id="auth-title">{authMode === 'login' ? 'Welcome back' : 'Join the conversation'}</h2>
              </div>
              <button type="button" className="icon-button close-auth" aria-label="Close" onClick={() => setAuthMode(null)}>×</button>
            </div>
            {authMode === 'login' ? (
              <>
                <form onSubmit={handleLogin} className="auth-form">
                  <label>Email<input required type="email" autoComplete="email" value={loginForm.email} onChange={(event) => setLoginForm((current) => ({ ...current, email: event.target.value }))} /></label>
                  <label>Password<input required type="password" autoComplete="current-password" value={loginForm.password} onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))} /></label>
                  <button type="submit" className="primary-btn full-width"><LogIn size={16} />Sign in</button>
                </form>
                <p className="auth-switch">New to EchoRoom? <button type="button" onClick={() => setAuthMode('register')}>Create an account</button></p>
              </>
            ) : (
              <>
                <form onSubmit={handleRegister} className="auth-form">
                  <label>Full name<input required autoComplete="name" value={registerForm.fullName} onChange={(event) => setRegisterForm((current) => ({ ...current, fullName: event.target.value }))} /></label>
                  <label>Email<input required type="email" autoComplete="email" value={registerForm.email} onChange={(event) => setRegisterForm((current) => ({ ...current, email: event.target.value }))} /></label>
                  <label>Password<input required minLength={8} type="password" autoComplete="new-password" value={registerForm.password} onChange={(event) => setRegisterForm((current) => ({ ...current, password: event.target.value }))} /></label>
                  <button type="submit" className="primary-btn full-width">Create free account</button>
                </form>
                <p className="auth-switch">Already have an account? <button type="button" onClick={() => setAuthMode('login')}>Sign in</button></p>
              </>
            )}
            <p className="auth-status" role="status">{status}</p>
          </section>
        </div>
      )}

      <main className={['home', 'about', 'pricing'].includes(activeTab) ? 'public-main' : 'content-grid'}>
        {activeTab === 'home' && (
          <>
            <section className="public-hero">
              <div className="public-hero-copy">
                <p className="eyebrow highlight">A better room for every idea</p>
                <h2>Bring your people together.<br /><span>Let the conversation flow.</span></h2>
                <p className="public-lede">Host live audio rooms, meet your next community, and turn great conversations into lasting connection.</p>
                <div className="cta-row">
                  <button type="button" className="primary-btn" onClick={() => profile ? setActiveTab('rooms') : setAuthMode('register')}>Start your free room</button>
                  <button type="button" className="secondary-btn" onClick={() => setActiveTab('rooms')}>Explore conversations</button>
                </div>
                <div className="hero-proof"><span className="proof-dot" /> A welcoming space for voices that deserve to be heard</div>
              </div>
              <div className="public-hero-visual">
                <img src="https://images.unsplash.com/photo-1598387993281-cecf8b71a8f8?auto=format&fit=crop&w=1200&q=85" alt="A host speaking into a microphone in a recording studio" />
                <div className="visual-caption"><span className="live-dot" /> LIVE NOW <strong>Ideas sound better together.</strong></div>
              </div>
            </section>

            <section className="trust-strip" aria-label="EchoRoom benefits">
              <span>Built for real conversation</span><i />
              <span>Audio-first community</span><i />
              <span>Made for hosts and listeners</span>
            </section>

            <section className="public-features">
              <div className="public-section-heading">
                <p className="eyebrow">Your community, in the moment</p>
                <h3>Everything a good conversation needs.</h3>
              </div>
              <div className="feature-grid">
                <article className="feature-item"><span className="feature-index">01</span><Mic size={21} /><h4>Live voice rooms</h4><p>Bring listeners and speakers into one focused, welcoming space.</p></article>
                <article className="feature-item"><span className="feature-index">02</span><Users size={21} /><h4>Community that grows</h4><p>Build an audience around shared interests, expertise, and curiosity.</p></article>
                <article className="feature-item"><span className="feature-index">03</span><MessageSquareText size={21} /><h4>Conversation continues</h4><p>Keep ideas moving with discussion threads, replies, and reactions.</p></article>
              </div>
            </section>
            <section className="public-close"><p className="eyebrow">Make room for more</p><h3>Your next great conversation starts here.</h3><button type="button" className="primary-btn" onClick={() => setAuthMode('register')}>Create your free account</button></section>
          </>
        )}

        {activeTab === 'about' && (
          <section className="about-page">
            <div className="about-intro">
              <p className="eyebrow highlight">About EchoRoom</p>
              <h2>Good communities begin when everyone has a voice.</h2>
              <p>EchoRoom brings people together through live audio and thoughtful discussion. It is a place for creators, teams, and curious communities to listen closely, share what they know, and build something together.</p>
              <button type="button" className="primary-btn" onClick={() => setAuthMode('register')}>Meet your community</button>
            </div>
            <div className="about-values">
              <article><span>01</span><div><h3>People before platforms</h3><p>Make it easy to show up, take part, and feel welcome in the room.</p></div></article>
              <article><span>02</span><div><h3>Conversation with purpose</h3><p>Give every host the tools to create focused, memorable experiences.</p></div></article>
              <article><span>03</span><div><h3>Community that lasts</h3><p>Keep the best ideas alive after the live moment has passed.</p></div></article>
            </div>
          </section>
        )}

        {activeTab === 'pricing' && (
          <section className="pricing-page">
            <div className="public-section-heading pricing-heading">
              <p className="eyebrow">Simple plans. Room to grow.</p>
              <h2>Find your community’s next stage.</h2>
              <p>Start small, bring your people, and grow when you’re ready.</p>
            </div>
            <div className="pricing-grid">
              <article className="price-plan"><p className="eyebrow">Starter</p><h3>Find your voice.</h3><div className="price"><strong>Free</strong></div><p>For exploring EchoRoom and starting your first community.</p><ul><li>Public live rooms</li><li>Community discussions</li><li>Member profiles</li></ul><button type="button" className="secondary-btn full-width" onClick={() => setAuthMode('register')}>Start free</button></article>
              <article className="price-plan featured-plan"><span className="plan-ribbon">FOR CREATORS</span><p className="eyebrow">Creator</p><h3>Make it a gathering.</h3><div className="price"><strong>$12</strong><span>/ month</span></div><p>For hosts building a regular audience around their ideas.</p><ul><li>Everything in Starter</li><li>Scheduled room programming</li><li>Audience and engagement insights</li></ul><button type="button" className="primary-btn full-width" onClick={() => window.location.href = 'mailto:hello@echoroom.app?subject=EchoRoom%20Creator%20plan'}>Talk to us</button></article>
              <article className="price-plan"><p className="eyebrow">Community</p><h3>Bring everyone in.</h3><div className="price"><strong>Let’s talk</strong></div><p>For organizations and communities with a bigger room to fill.</p><ul><li>Everything in Creator</li><li>Multiple community hosts</li><li>Dedicated onboarding</li></ul><button type="button" className="secondary-btn full-width" onClick={() => window.location.href = 'mailto:hello@echoroom.app?subject=EchoRoom%20Community%20plan'}>Contact sales</button></article>
            </div>
            <p className="pricing-note">Creator and Community plans are presented for planning; online checkout is not enabled in this build.</p>
          </section>
        )}

        {activeTab === 'overview' && (
          <>
            <section className="dashboard-welcome panel wide-panel">
              <div><p className="eyebrow highlight">Your EchoRoom</p><h2>Welcome back, {profile?.fullName.split(' ')[0] ?? 'there'}.</h2><p>Pick up a conversation or open a room of your own.</p></div>
              <button type="button" className="primary-btn" onClick={() => setActiveTab('rooms')}>Explore rooms</button>
            </section>
            <section className="panel content-panel wide-panel">
              <div className="section-heading"><p className="eyebrow">for you</p><h3>Rooms worth joining</h3></div>
              <div className="room-grid">
                {rooms.slice(0, 3).map((room) => (
                  <article className="room-card" key={room.id}>
                    <div className="room-card-top"><div><span className="category-tag">{room.category}</span><h4>{room.title}</h4></div><span className={roomStatusClass(room)}>{roomStatusLabel(room)}</span></div>
                    <p>{room.description}</p><div className="meta-row"><span>{room.listeners} listeners</span><span>{room.speakers.length} speakers</span></div>
                    <div className="host-row"><span>Host: {room.host}</span><button type="button" className="small-btn" onClick={() => void handleJoinRoom(room.id, profile?.username ?? 'Guest Listener')}>Join</button></div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}

        {activeTab === 'rooms' && (
          <section className="panel content-panel wide-panel">
            <div className="section-heading">
              <p className="eyebrow">explore</p>
              <h3>Live rooms</h3>
            </div>

            <div className="room-list">
              {rooms.map((room) => (
                <div className="room-list-item" key={room.id}>
                  <div>
                    <span className="category-tag">{room.category}</span>
                    <h4>{room.title}</h4>
                    <p>{room.description}</p>
                  </div>
                  <div className="room-actions">
                    <span>{room.listeners} listeners</span>
                    <button type="button" className="primary-btn" onClick={() => void handleJoinRoom(room.id, profile?.username ?? 'Guest Listener')}>
                      Join room
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {profile && (
              <form className="create-form" onSubmit={handleCreateRoom}>
                <h4>Start a room</h4>
                <div className="create-form-grid">
                  <label>
                    Room title
                    <input required maxLength={100} value={roomForm.title} onChange={(event) => setRoomForm((current) => ({ ...current, title: event.target.value }))} />
                  </label>
                  <label>
                    Category
                    <select value={roomForm.category} onChange={(event) => setRoomForm((current) => ({ ...current, category: event.target.value }))}>
                      <option>Technology</option>
                      <option>Business</option>
                      <option>Music</option>
                      <option>Lifestyle</option>
                      <option>Education</option>
                    </select>
                  </label>
                  <label className="full-row">
                    Description
                    <input maxLength={500} value={roomForm.description} onChange={(event) => setRoomForm((current) => ({ ...current, description: event.target.value }))} />
                  </label>
                </div>
                <button type="submit" className="primary-btn">Create live room</button>
              </form>
            )}

            {joinMessage && <p className="join-message">{joinMessage}</p>}

            {activeRoom && (
              <section className="live-room-panel">
                <div className="live-room-heading">
                  <div>
                    <p className="eyebrow">you are in</p>
                    <h4>{activeRoom.title}</h4>
                    <span>{activeRoom.speakers.length + remoteStreams.length} speakers · {activeRoom.listeners} listeners</span>
                  </div>
                  <div className="live-room-actions">
                    <button type="button" className={microphoneEnabled ? 'primary-btn mic-active' : 'secondary-btn'} onClick={() => void handleToggleMicrophone()}>
                      <Mic size={16} /> {microphoneEnabled ? 'Mute microphone' : 'Enable microphone'}
                    </button>
                    <button type="button" className="secondary-btn" onClick={() => void handleSpeakerRequest()}>Request to speak</button>
                    <button type="button" className="leave-btn" onClick={() => void handleLeaveRoom()}>Leave room</button>
                  </div>
                </div>

                <div className="room-chat" aria-live="polite">
                  {chatMessages.length === 0 ? (
                    <p className="chat-empty">The conversation starts here. Say hello to the room.</p>
                  ) : chatMessages.map((message) => (
                    <article className="chat-message" key={message.id}>
                      <strong>{message.user.fullName}</strong>
                      <p>{message.content}</p>
                      <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </article>
                  ))}
                </div>

                <form className="chat-form" onSubmit={handleSendMessage}>
                  <input aria-label="Chat message" maxLength={1000} value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} placeholder="Write a message to the room" />
                  <button type="submit" className="primary-btn" disabled={!messageDraft.trim()}>Send</button>
                </form>
                <div className="remote-audio" aria-hidden="true">
                  {remoteStreams.map(({ peerId, stream }) => (
                    <audio key={peerId} autoPlay ref={(element) => { if (element && element.srcObject !== stream) element.srcObject = stream }} />
                  ))}
                </div>
              </section>
            )}
          </section>
        )}

        {activeTab === 'discussions' && (
          <section className="panel content-panel wide-panel">
            <div className="section-heading">
              <p className="eyebrow">community</p>
              <h3>Open discussions</h3>
            </div>

            <div className="discussion-list">
              {discussions.map((discussion) => (
                <article className="discussion-card" key={discussion.id}>
                  <div className="discussion-header">
                    <span className="category-tag">{discussion.category}</span>
                    <span className="discussion-author">by {discussion.author}</span>
                  </div>
                  <h4>{discussion.title}</h4>
                  {discussion.content && <p className="discussion-content">{discussion.content}</p>}
                  <div className="discussion-stats">
                    <span>{discussion.comments} comments</span>
                    <span>{discussion.reactions} reactions</span>
                  </div>
                  <div className="discussion-actions">
                    <button type="button" className={reactedDiscussions[discussion.id] ? 'discussion-action active' : 'discussion-action'} onClick={() => void handleToggleReaction(discussion.id)}>
                      {reactedDiscussions[discussion.id] ? 'Liked' : 'Like'}
                    </button>
                    <button type="button" className="discussion-action" onClick={() => void handleToggleComments(discussion.id)}>
                      {openDiscussionId === discussion.id ? 'Hide replies' : 'View replies'}
                    </button>
                  </div>
                  {openDiscussionId === discussion.id && (
                    <div className="comment-thread">
                      {(commentThreads[discussion.id] ?? []).map((comment) => (
                        <article className="comment-item" key={comment.id}>
                          <strong>{comment.user.fullName}</strong>
                          <p>{comment.content}</p>
                        </article>
                      ))}
                      {profile && (
                        <form className="comment-form" onSubmit={(event) => void handleCreateComment(discussion.id, event)}>
                          <input
                            aria-label={`Reply to ${discussion.title}`}
                            maxLength={2000}
                            value={commentDrafts[discussion.id] ?? ''}
                            onChange={(event) => setCommentDrafts((current) => ({ ...current, [discussion.id]: event.target.value }))}
                            placeholder="Write a reply"
                          />
                          <button type="submit" className="small-btn" disabled={!commentDrafts[discussion.id]?.trim()}>Reply</button>
                        </form>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>

            {profile && (
              <form className="create-form" onSubmit={handleCreateDiscussion}>
                <h4>Start a discussion</h4>
                <div className="create-form-grid">
                  <label>
                    Title
                    <input required maxLength={120} value={discussionForm.title} onChange={(event) => setDiscussionForm((current) => ({ ...current, title: event.target.value }))} />
                  </label>
                  <label>
                    Category
                    <select value={discussionForm.category} onChange={(event) => setDiscussionForm((current) => ({ ...current, category: event.target.value }))}>
                      <option>Technology</option>
                      <option>Business</option>
                      <option>Music</option>
                      <option>Lifestyle</option>
                      <option>Education</option>
                    </select>
                  </label>
                  <label className="full-row">
                    Your post
                    <textarea required maxLength={5000} rows={4} value={discussionForm.content} onChange={(event) => setDiscussionForm((current) => ({ ...current, content: event.target.value }))} />
                  </label>
                </div>
                <button type="submit" className="primary-btn">Publish discussion</button>
              </form>
            )}
          </section>
        )}

        {activeTab === 'notifications' && (
          <section className="panel content-panel wide-panel">
            <div className="section-heading">
              <p className="eyebrow">updates</p>
              <h3>Notifications</h3>
            </div>

            <div className="notification-list">
              {notifications.map((notification) => (
                <button type="button" key={notification.id} className={notification.read ? 'notification-item read' : 'notification-item'} onClick={() => void handleMarkRead(notification.id)}>
                  <div>
                    <span className="notification-type">{notification.type}</span>
                    <strong>{notification.title}</strong>
                    <p>{notification.message}</p>
                  </div>
                  {!notification.read && <span className="dot" />}
                </button>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'feedback' && (
          <section className="panel content-panel wide-panel">
            <div className="section-heading">
              <p className="eyebrow">help us improve</p>
              <h3>Send feedback</h3>
            </div>
            {profile ? (
              <form className="create-form" onSubmit={handleSubmitFeedback}>
                <div className="create-form-grid">
                  <label>
                    Category
                    <select value={feedbackForm.category} onChange={(event) => setFeedbackForm((current) => ({ ...current, category: event.target.value }))}>
                      <option>Product</option>
                      <option>Audio quality</option>
                      <option>Accessibility</option>
                      <option>Safety</option>
                      <option>Other</option>
                    </select>
                  </label>
                  <label>
                    Rating
                    <select value={feedbackForm.rating} onChange={(event) => setFeedbackForm((current) => ({ ...current, rating: event.target.value }))}>
                      <option value="5">5 - Excellent</option>
                      <option value="4">4 - Good</option>
                      <option value="3">3 - Okay</option>
                      <option value="2">2 - Needs work</option>
                      <option value="1">1 - Poor</option>
                    </select>
                  </label>
                  <label className="full-row">
                    Subject
                    <input required maxLength={120} value={feedbackForm.subject} onChange={(event) => setFeedbackForm((current) => ({ ...current, subject: event.target.value }))} />
                  </label>
                  <label className="full-row">
                    Details
                    <textarea required maxLength={5000} rows={5} value={feedbackForm.description} onChange={(event) => setFeedbackForm((current) => ({ ...current, description: event.target.value }))} />
                  </label>
                </div>
                <button type="submit" className="primary-btn">Submit feedback</button>
              </form>
            ) : <p className="auth-required">Sign in to send feedback.</p>}
          </section>
        )}

        {activeTab === 'admin' && stats && (
          <section className="admin-page wide-panel">
            <header className="admin-heading">
              <div><p className="eyebrow">private workspace · admin</p><h2>Platform operations</h2><p>Monitor community activity and take action when a room or report needs attention.</p></div>
              <span className="admin-access"><ShieldCheck size={16} /> Verified admin</span>
            </header>

            <div className="stats-grid admin-metrics">
              <div className="metric-box"><Users size={18} /><span>Members</span><strong>{stats.users}</strong></div>
              <div className="metric-box"><span>Active members</span><strong>{stats.activeUsers}</strong></div>
              <div className="metric-box"><Mic size={18} /><span>Live rooms</span><strong>{stats.activeRooms}</strong></div>
              <div className="metric-box"><MessageSquareText size={18} /><span>Discussions</span><strong>{stats.discussions}</strong></div>
              <div className="metric-box"><ShieldCheck size={18} /><span>Open reports</span><strong>{stats.reports}</strong></div>
              <div className="metric-box"><Sparkles size={18} /><span>Feedback entries</span><strong>{stats.feedback}</strong></div>
            </div>

            <div className="admin-columns">
              <section className="admin-section">
                <div className="admin-section-heading"><div><p className="eyebrow">live moderation</p><h3>Room monitor</h3></div><span>{adminOverview?.rooms.filter((room) => room.live).length ?? 0} live</span></div>
                <div className="admin-record-list">
                  {adminOverview?.rooms.map((room) => (
                    <article className="admin-record" key={room.id}>
                      <div><span className={roomStatusClass(room)}>{roomStatusLabel(room)}</span><h4>{room.title}</h4><p>{room.category} · Host {room.host}</p></div>
                      {room.live && <button type="button" className="leave-btn" onClick={() => void handleEndRoom(room.id)}>End room</button>}
                    </article>
                  ))}
                  {!adminOverview?.rooms.length && <p className="admin-empty">No rooms to monitor yet.</p>}
                </div>
              </section>

              <section className="admin-section">
                <div className="admin-section-heading"><div><p className="eyebrow">safety queue</p><h3>Reports</h3></div></div>
                <div className="admin-record-list">
                  {adminOverview?.reports.map((report) => (
                    <article className="admin-record" key={report.id}>
                      <div><span className="category-tag">{report.entityType}</span><h4>{report.reason}</h4><p>{report.status} · {new Date(report.createdAt).toLocaleDateString()}</p></div>
                      {report.status === 'OPEN' && <button type="button" className="small-btn" onClick={() => void handleResolveReport(report.id)}>Resolve</button>}
                    </article>
                  ))}
                  {!adminOverview?.reports.length && <p className="admin-empty">No reports need review.</p>}
                </div>
              </section>

              <section className="admin-section">
                <div className="admin-section-heading"><div><p className="eyebrow">community</p><h3>Recent members</h3></div></div>
                <div className="admin-record-list">
                  {adminOverview?.members.map((member) => (
                    <article className="admin-record" key={member.id}>
                      <div><h4>{member.fullName}</h4><p>@{member.username} · {member.email}</p></div><span className="admin-status-tag">{member.role}</span>
                    </article>
                  ))}
                </div>
              </section>

              <section className="admin-section">
                <div className="admin-section-heading"><div><p className="eyebrow">voice of customer</p><h3>Recent feedback</h3></div></div>
                <div className="admin-record-list">
                  {adminOverview?.feedback.map((item) => (
                    <article className="admin-record" key={item.id}><div><span className="category-tag">{item.category}</span><h4>{item.subject}</h4></div><span className="admin-status-tag">{item.status}</span></article>
                  ))}
                  {!adminOverview?.feedback.length && <p className="admin-empty">Feedback from members will appear here.</p>}
                </div>
              </section>
            </div>
          </section>
        )}
      </main>
      <footer className="site-footer">
        <span>EchoRoom · Voice, in good company.</span>
        <div>
          <button type="button" onClick={() => setActiveTab('about')}>About</button>
          <button type="button" onClick={() => setActiveTab('pricing')}>Plans</button>
          <button type="button" onClick={() => setActiveTab('rooms')}>Explore rooms</button>
        </div>
      </footer>
    </div>
  )
}

export default App

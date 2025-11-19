import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, ZoomIn, ZoomOut, Upload, Eye, EyeOff, FileAudio, FileVideo, FileText, Download, Subtitles, Github, Plus, Trash2 } from 'lucide-react'
import { computeDER, type ErrorInterval, type DERMetrics } from './utils'

type MediaType = 'audio' | 'video'

interface MediaFile {
  id: string
  name: string
  type: MediaType
  duration?: number
  url: string
  size?: number
}

interface RTTMFile {
  id: string
  name: string
  url: string
  matched: boolean
}

interface SRTFile {
  id: string
  name: string
  url: string
  subtitles: Subtitle[]
}

interface Subtitle {
  id: number
  start: number
  end: number
  text: string
}

interface Segment {
  id: string
  speakerId: string
  start: number
  end: number
}

interface Speaker {
  id: string
  name: string
  color: string
  visible: boolean
}



function formatTime(sec:number){
  const m = Math.floor(sec/60)
  const s = Math.floor(sec%60).toString().padStart(2,'0')
  return `${m}:${s}`
}

function formatHMSms(seconds: number){
  const sign = seconds < 0 ? '-' : ''
  const t = Math.abs(seconds)
  const hours = Math.floor(t/3600)
  const minutes = Math.floor((t%3600)/60)
  const secs = t%60
  if(hours > 0) {
    return `${sign}${hours}:${minutes.toString().padStart(2,'0')}:${secs.toFixed(1).padStart(4,'0')}`
  } else {
    return `${sign}${minutes}:${secs.toFixed(1).padStart(4,'0')}`
  }
}

function parseSRT(text: string): Subtitle[] {
  const subtitles: Subtitle[] = []
  const blocks = text.trim().split(/\r?\n\r?\n/)
  
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    if (lines.length < 3) continue
    
    const id = parseInt(lines[0])
    if (isNaN(id)) continue
    
    const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
    if (!timeMatch) continue
    
    const start = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000
    const end = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000
    
    const text = lines.slice(2).join('\n').trim()
    
    subtitles.push({ id, start, end, text })
  }
  
  return subtitles.sort((a, b) => a.start - b.start)
}

function parseRTTM(text:string): {segments:Segment[], speakers:Speaker[]} {
  const segs: Segment[] = []
  const speakerIndex = new Map<string, Speaker>()
  const colorPalette = [
    '#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899'
  ]
  let colorPtr = 0
  for(const raw of text.split(/\r?\n/)){
    const l = raw.trim()
    if(!l || l.startsWith(';')) continue
    const f = l.split(/\s+/)
    if(f[0] !== 'SPEAKER') continue
    const start = parseFloat(f[3])
    const dur = parseFloat(f[4])
    const spk = f[7] || 'spk'
    const end = start + dur
    const id = `${spk}_${start.toFixed(3)}_${end.toFixed(3)}`
    segs.push({id, speakerId: spk, start, end})
    if(!speakerIndex.has(spk)){
      const color = colorPalette[colorPtr % colorPalette.length]; colorPtr++
      speakerIndex.set(spk, { id: spk, name: spk, color, visible: true })
    }
  }
  const speakers = Array.from(speakerIndex.values())
  segs.sort((a,b)=>a.start-b.start)
  return {segments: segs, speakers}
}

const sampleVideo = "https://videos.pexels.com/video-files/30333849/13003128_2560_1440_25fps.mp4"

// Load local defaults from exp/ using Vite glob imports
// RTTM as raw text; media as URLs
const defaultRttmFiles = import.meta.glob('/exp/rttm/*.rttm', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const defaultMediaFiles = import.meta.glob('/exp/raw/*.{mp4,webm,mp3,wav,m4a}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

export default function App(){
  const [title] = useState('RTTM Visualizer') // 1) Title updated
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [media, setMedia] = useState<MediaFile|null>({ id:'sample', name:'sample.mp4', type:'video', url: sampleVideo })
  const [rttm, setRTTM] = useState<RTTMFile|null>(null)
  const [refRTTM, setRefRTTM] = useState<RTTMFile|null>(null)
  const [srt, setSRT] = useState<SRTFile|null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [refSegments, setRefSegments] = useState<Segment[]>([])
  const [ghostSeg, setGhostSeg] = useState<{speakerId:string; start:number; end:number} | null>(null)
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [derOverlay, setDerOverlay] = useState<ErrorInterval[]>([])
  const [metrics, setMetrics] = useState<DERMetrics | null>(null)
  const [showDER, setShowDER] = useState<boolean>(true)
  const [showRefTrack, setShowRefTrack] = useState<boolean>(true)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const centerRef = useRef<HTMLDivElement>(null)
  const [videoAreaHeight, setVideoAreaHeight] = useState<number>(400)
  const resizeStateRef = useRef<{startY:number; startH:number} | null>(null)
  const isScrubbingRef = useRef(false)
  const defaultLoadedRef = useRef(false)
  const [selectedSegId, setSelectedSegId] = useState<string|null>(null)
  const dragRef = useRef<{ type: 'start'|'end'|'move'|'create'; speakerId: string; segId?: string; anchorTime?: number } | null>(null)
  const [dragTip, setDragTip] = useState<{x:number;y:number;text:string}|null>(null)
  const segmentsRef = useRef<Segment[]>([])
  useEffect(()=>{ segmentsRef.current = segments }, [segments])
  const [ctxMenu, setCtxMenu] = useState<{x:number; y:number; segId: string} | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{open: boolean; segId: string} | null>(null)
  const lastDeletedRef = useRef<Segment | null>(null)
  const [toast, setToast] = useState<{message: string; actionLabel?: string; onAction?: ()=>void} | null>(null)
  const [playbackRate, setPlaybackRate] = useState<number>(1.0); // 默认 1x

  useEffect(()=>{
    const closeMenu = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if(e.key==='Escape'){ setCtxMenu(null); setConfirmDelete(null) } }
    window.addEventListener('click', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // drag-n-drop upload (global)
  const [dragOver, setDragOver] = useState(false)
  // per-section upload inputs
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const rttmInputRef = useRef<HTMLInputElement>(null)
  const refRttmInputRef = useRef<HTMLInputElement>(null)
  const srtInputRef = useRef<HTMLInputElement>(null)
  const onDrop = useCallback((e: React.DragEvent)=>{
    e.preventDefault(); setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    handleFiles(files)
  },[])
  function handleFiles(files: File[], target?: 'sys'|'ref'){
    for(const f of files){
      if(f.name.toLowerCase().endsWith('.rttm')){
        const url = URL.createObjectURL(f)
        const reader = new FileReader()
        reader.onload = () => {
          const {segments, speakers} = parseRTTM(String(reader.result))
          const isRefTarget = (target==='ref') || (/\bref\b/i.test(f.name)) || (!!rttm && !refRTTM)
          if(isRefTarget){
            setRefSegments(segments)
            setRefRTTM({ id: crypto.randomUUID(), name:f.name, url, matched: true })
          } else {
            setSegments(segments); setSpeakers(speakers)
            setRTTM({ id: crypto.randomUUID(), name:f.name, url, matched: true })
          }
        }
        reader.readAsText(f)
      } else if(f.name.toLowerCase().endsWith('.srt')){
        const url = URL.createObjectURL(f)
        const reader = new FileReader()
        reader.onload = () => {
          const subtitles = parseSRT(String(reader.result))
          setSRT({ id: crypto.randomUUID(), name: f.name, url, subtitles })
        }
        reader.readAsText(f)
      } else if(/\.(mp4|webm|mp3|wav|m4a)$/i.test(f.name)){
        const url = URL.createObjectURL(f)
        const type: MediaType = /\.(mp4|webm)$/i.test(f.name) ? 'video' : 'audio'
        setMedia({ id: crypto.randomUUID(), name: f.name, type, url, size: f.size })
      }
    }
  }

  // Get current subtitle based on current time
  const currentSubtitle = useMemo(() => {
    if (!srt?.subtitles) return null
    return srt.subtitles.find(sub => currentTime >= sub.start && currentTime < sub.end) || null
  }, [srt, currentTime])

  // Get next subtitle for preview
  const nextSubtitle = useMemo(() => {
    if (!srt?.subtitles) return null
    return srt.subtitles.find(sub => sub.start > currentTime) || null
  }, [srt, currentTime])

  // Index of current subtitle and a window around it
  const currentSubtitleIndex = useMemo(() => {
    if (!srt?.subtitles) return -1
    const list = srt.subtitles
    for (let i = 0; i < list.length; i++) {
      const sub = list[i]
      if (currentTime >= sub.start && currentTime < sub.end) return i
      if (currentTime < sub.start) return i - 1
    }
    return list.length - 1
  }, [srt, currentTime])

  const aroundSubtitles = useMemo(() => {
    if (!srt?.subtitles) return [] as Array<{sub: Subtitle; isCurrent: boolean}>
    const startIdx = Math.max(0, currentSubtitleIndex - 3)
    const endIdx = Math.min(srt.subtitles.length, currentSubtitleIndex + 7)
    return srt.subtitles.slice(startIdx, endIdx).map((sub) => ({ sub, isCurrent: currentSubtitle?.id === sub.id }))
  }, [srt, currentSubtitleIndex, currentSubtitle])

  const aroundListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = aroundListRef.current
    if (!el) return
    const currentEl = el.querySelector('.sub-item.current') as HTMLElement | null
    if (currentEl) currentEl.scrollIntoView({ block: 'center' })
  }, [currentSubtitle?.id])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate])

  // Default tracks when no RTTM is loaded
  const defaultTracks = useMemo(() => {
    if (speakers.length > 0) return []
    const palette = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899','#14B8A6','#F472B6']
    return Array.from({length: 10}).map((_, i) => ({
      id: `default-${i+1}`,
      name: `Track ${i+1}`,
      color: palette[i % palette.length],
      visible: true,
    }))
  }, [speakers.length])

  // All tracks (RTTM speakers + default tracks)
  const allTracks = useMemo(() => {
    if (speakers.length > 0) return speakers
    return defaultTracks
  }, [speakers, defaultTracks])

  // search query for subtitles
  const [subtitleQuery, setSubtitleQuery] = useState('')
  const allSubtitles = useMemo(() => {
    return srt?.subtitles ?? []
  }, [srt])
  const visibleSubtitles = useMemo(() => {
    const q = subtitleQuery.trim().toLowerCase()
    if (!q) return allSubtitles
    return allSubtitles.filter(s => s.text.toLowerCase().includes(q))
  }, [allSubtitles, subtitleQuery])

  // right panel auto collapse/expand logic based on data presence
  const hasRTTM = useMemo(()=> (!!rttm) || speakers.length>0, [rttm, speakers.length])
  const hasRef = useMemo(()=> (!!refRTTM) || refSegments.length>0, [refRTTM, refSegments.length])
  const hasSRT = useMemo(()=> !!srt, [srt])
  useEffect(()=>{
    if(!hasRTTM && !hasSRT) setRightCollapsed(true)
    else setRightCollapsed(false)
  }, [hasRTTM, hasSRT])

  // playback controls below video (requirement 2)
  const togglePlay = () => {
    const el = videoRef.current
    if(!el) return
    if(el.paused){ el.play(); el.playbackRate = playbackRate; setIsPlaying(true) } else { el.pause(); setIsPlaying(false) }
  }
  const seek = (t:number) => {
    const el = videoRef.current; if(!el) return
    el.currentTime = Math.max(0, Math.min(t, duration||el.duration||0))
  }
  const onTimeUpdate = () => {
    const el = videoRef.current; if(!el) return
    setCurrentTime(el.currentTime)
    if(el.duration && el.duration !== duration) setDuration(el.duration)
  }
  const onLoadedMetadata = () => {
    const el = videoRef.current; if(!el) return
    setDuration(el.duration || 0)
  }

  // Load default media and RTTM from exp/ folders on first mount
  useEffect(()=>{
    if(defaultLoadedRef.current) return
    defaultLoadedRef.current = true
    try {
      const mediaKeys = Object.keys(defaultMediaFiles).sort()
      if(mediaKeys.length > 0){
        const mp4First = mediaKeys.find(k=>/\.mp4$/i.test(k)) || mediaKeys[0]
        const url = defaultMediaFiles[mp4First]
        const name = mp4First.split('/').pop() || 'media'
        const type: MediaType = /\.(mp4|webm)$/i.test(name) ? 'video' : 'audio'
        setMedia({ id: 'default-media', name, type, url })
      }
      const rttmKeys = Object.keys(defaultRttmFiles).sort()
      if(rttmKeys.length > 0){
        const firstPath = rttmKeys[0]
        const content = defaultRttmFiles[firstPath]
        const name = firstPath.split('/').pop() || 'segments.rttm'
        const parsed = parseRTTM(content)
        setSegments(parsed.segments)
        setSpeakers(parsed.speakers)
        const blob = new Blob([content], {type:'text/plain'})
        const url = URL.createObjectURL(blob)
        setRTTM({ id: 'default-rttm', name, url, matched: true })
      }
    } catch (e) {
      // ignore
    }
  }, [])

  // smoother UI updates while playing
  useEffect(()=>{
    let rafId: number | null = null
    const tick = () => {
      const el = videoRef.current
      if(el){ setCurrentTime(el.currentTime) }
      rafId = requestAnimationFrame(tick)
    }
    if(isPlaying){ rafId = requestAnimationFrame(tick) }
    return ()=> { if(rafId!==null) cancelAnimationFrame(rafId) }
  }, [isPlaying])

  // prev/next segment buttons logic
  const visibleSegments = useMemo(()=>{
    const visibleSpk = new Set(speakers.filter(s=>s.visible).map(s=>s.id))
    return segments.filter(s=>visibleSpk.has(s.speakerId))
  }, [segments, speakers])
  const jumpPrev = () => {
    const before = visibleSegments.filter(s => s.start < currentTime - 0.05)
    if(before.length === 0) { seek(0); return }
    const target = before[before.length-1]
    seek(target.start)
  }
  const jumpNext = () => {
    const after = visibleSegments.filter(s => s.start > currentTime + 0.05)
    if(after.length === 0) { seek(duration); return }
    const target = after[0]
    seek(target.start)
  }

  // zoom buttons
  const zoomOut = ()=> setZoom(z => Math.max(0.25, +(z-0.25).toFixed(2)))
  const zoomIn = ()=> setZoom(z => Math.min(10, +(z+0.25).toFixed(2)))

  // keyboard
  useEffect(()=>{
    const onKey = (e: KeyboardEvent) => {
      if(e.code === 'Space'){ console.log('Space'); e.preventDefault(); togglePlay() }
      if(e.key === 'ArrowLeft'){ console.log('ArrowLeft'); seek(currentTime - 1) }
      if(e.key === 'ArrowRight'){ console.log('ArrowRight'); seek(currentTime + 1) }
      if((e.ctrlKey||e.metaKey) && (e.key==='=' || e.key==='+')) zoomIn()
      if((e.ctrlKey||e.metaKey) && e.key==='-') zoomOut()
      if(e.key === 'Delete' || e.key === 'Backspace'){
        console.log('Delete/Backspace pressed, selectedSegId=', selectedSegId)
        // Ignore Delete when user is typing in an editable element
        const active = document.activeElement as HTMLElement | null
        const isEditable = !!active && (
          active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable ||
          !!active.closest('input, textarea, [contenteditable="true"]')
        )
        if(isEditable){ console.log('Editable focused, skip'); return }
        if(selectedSegId && !confirmDelete){
          e.preventDefault();
          console.log('Open confirm delete for', selectedSegId)
          setConfirmDelete({ open: true, segId: selectedSegId })
        } else { console.log('No segment selected, ignore delete') }
      }
      if(confirmDelete?.open && e.key === 'Enter'){
        console.log('Enter confirm delete')
        e.preventDefault()
        const targetId = confirmDelete.segId
        removeTimeSegment(targetId)
        setConfirmDelete(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return ()=> window.removeEventListener('keydown', onKey)
  }, [currentTime, duration, selectedSegId, confirmDelete])

  // timeline dims
  const pxPerSec = 80 * zoom
  const timelineWidth = Math.max(400, Math.ceil((duration||60) * pxPerSec))
  
  // Calculate optimal time division based on zoom level
  const timeDivision = useMemo(() => {
    if (zoom >= 8) return 1/60 // ~frame-level at 60fps
    if (zoom >= 6) return 1/30 // frame-level at 30fps
    if (zoom >= 4) return 0.1  // 100ms
    if (zoom >= 2) return 0.5  // 500ms
    if (zoom >= 1) return 1    // 1s
    if (zoom >= 0.5) return 2  // 2s
    return 5                   // 5s
  }, [zoom])

  const trackCount = speakers.length>0 ? speakers.length : Math.min(4, 10) // 默认最多显示4个空轨道
  const hasRefTrackVisible = showRefTrack && refSegments.length > 0
  const actualTrackCount = trackCount + (hasRefTrackVisible ? 1 : 0)
  const timelineMinHeight = 24 + 56 + Math.max(2, actualTrackCount) * 28 // ruler + wave + tracks

  // click timeline seek
  const waveRef = useRef<HTMLDivElement>(null)
  const waveCanvasRef = useRef<HTMLCanvasElement>(null)
  const onClickTimeline = (e: React.MouseEvent) => {
    const el = waveRef.current; if(!el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left + el.scrollLeft
    const t = x / pxPerSec
    seek(t)
  }

  // Pointer-based scrubbing (press-and-hold to move playhead)
  const scrubAtClient = (clientX: number) => {
    const el = waveRef.current; if(!el) return
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft
    const t = x / pxPerSec
    seek(t)
  }
  const onTimelinePointerDown = (e: React.PointerEvent) => {
    isScrubbingRef.current = true
    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch {}
    scrubAtClient(e.clientX)
    e.preventDefault()
  }
  const onTimelinePointerMove = (e: React.PointerEvent) => {
    if(!isScrubbingRef.current) return
    scrubAtClient(e.clientX)
  }
  const onTimelinePointerUp = (e: React.PointerEvent) => {
    isScrubbingRef.current = false
    try { (e.target as Element).releasePointerCapture?.(e.pointerId) } catch {}
  }

  // Helpers for drag/creation logic
  const MIN_DUR = 0.01 // 10ms
  const toTimeFromClientX = (clientX: number) => {
    const el = waveRef.current; if(!el) return 0
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft
    return Math.max(0, Math.min((duration||0), x / pxPerSec))
  }

  const getSpeakerNeighborBounds = (speakerId: string, segId?: string) => {
    const list = segments.filter(s=>s.speakerId===speakerId).sort((a,b)=>a.start-b.start)
    let prevEnd = 0
    let nextStart = duration || Number.POSITIVE_INFINITY
    for(let i=0;i<list.length;i++){
      const s = list[i]
      if(segId && s.id===segId){
        if(i>0) prevEnd = list[i-1].end
        if(i<list.length-1) nextStart = list[i+1].start
        break
      }
    }
    if(!segId && list.length>0){
      // For creation we just use full bounds (no overlap across existing segments)
      // We will clamp later against nearest neighbors based on the new time
    }
    return {prevEnd, nextStart}
  }

  const updateSegmentTime = (segId: string, nextStart: number, nextEnd: number) => {
    setSegments(prev => {
      const target = prev.find(s=>s.id===segId)
      if(!target) return prev
      const {prevEnd, nextStart: ns} = getSpeakerNeighborBounds(target.speakerId, segId)
      const clampedStart = Math.max(prevEnd, Math.min(nextStart, ns - MIN_DUR))
      const clampedEnd = Math.max(clampedStart + MIN_DUR, Math.min(nextEnd, ns))
      return prev.map(s=> s.id===segId? {...s, start: clampedStart, end: clampedEnd}: s)
    })
  }

  const createSegmentAt = (speakerId: string, atTime: number) => {
    const id = crypto.randomUUID()
    const baseStart = atTime
    const baseEnd = Math.min((duration||atTime+1), atTime + 0.2)
    const newSeg: Segment = { id, speakerId, start: baseStart, end: baseEnd }
    setSegments(prev => {
      // Prevent overlap on insert by shrinking into nearest gap
      const list = prev.filter(s=>s.speakerId===speakerId).sort((a,b)=>a.start-b.start)
      let leftBound = 0
      let rightBound = duration || Number.POSITIVE_INFINITY
      for(let i=0;i<list.length;i++){
        const s = list[i]
        if(s.end <= atTime){ leftBound = Math.max(leftBound, s.end) }
        if(s.start >= atTime && rightBound=== (duration||Number.POSITIVE_INFINITY)){ rightBound = s.start }
      }
      const start = Math.max(leftBound, Math.min(baseStart, rightBound - MIN_DUR))
      const end = Math.max(start + MIN_DUR, Math.min(baseEnd, rightBound))
      const adjusted = {...newSeg, start, end}
      return [...prev, adjusted].sort((a,b)=> a.start-b.start)
    })
    setSelectedSegId(id)
    return id
  }

  // Remove segment with optional undo
  const removeTimeSegment = (segId: string) => {
    const seg = segmentsRef.current.find(s=>s.id===segId) || null
    if(!seg) return
    lastDeletedRef.current = seg
    setSegments(prev => prev.filter(s=> s.id!==segId))
    setSelectedSegId(v => v===segId ? null : v)
    const undo = () => {
      const snap = lastDeletedRef.current
      if(!snap) return
      setSegments(prev => [...prev, snap].sort((a,b)=> a.start-b.start))
      lastDeletedRef.current = null
      setToast(null)
    }
    setToast({ message: '已删除一个时间段', actionLabel: '撤销', onAction: undo })
    window.setTimeout(()=>{ setToast(null) }, 5000)
  }

  // auto-scroll timeline to keep playhead in view (throttled, no repeated smooth to avoid jitter)
  const autoScrollStateRef = useRef<{ lastTs: number; lastLeft: number }>({ lastTs: 0, lastLeft: 0 })
  useEffect(()=>{
    const el = waveRef.current; if(!el) return
    const playheadX = currentTime * pxPerSec
    const viewLeft = el.scrollLeft
    const viewRight = viewLeft + el.clientWidth
    const margin = Math.max(60, el.clientWidth * 0.2)

    // Only scroll when the playhead is getting too close to the edges
    const isNearEdge = playheadX < viewLeft + margin || playheadX > viewRight - margin
    if(!isNearEdge) return

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const { lastTs } = autoScrollStateRef.current
    if(now - lastTs < 80) return // throttle ~12.5 fps

    const targetLeft = Math.max(0, playheadX - el.clientWidth / 2)
    if(Math.abs(targetLeft - viewLeft) < 4) return // tiny changes ignored

    el.scrollLeft = targetLeft // immediate jump to avoid interrupting smooth scroll repeatedly
    autoScrollStateRef.current.lastTs = now
    autoScrollStateRef.current.lastLeft = targetLeft
  }, [currentTime, pxPerSec])

  // Vertical resize of video area
  const onResizeMouseDown = (e: React.MouseEvent) => {
    resizeStateRef.current = { startY: e.clientY, startH: videoAreaHeight }
    const onMove = (ev: MouseEvent) => {
      const start = resizeStateRef.current; if(!start) return
      const centerH = centerRef.current?.clientHeight || 600
      const minH = 140
      const maxH = Math.max(minH, centerH - 140)
      const next = Math.max(minH, Math.min(maxH, start.startH + (ev.clientY - start.startY)))
      setVideoAreaHeight(next)
    }
    const onUp = () => {
      resizeStateRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }

  // tooltip on hover segment
  const [tooltip, setTooltip] = useState<{x:number;y:number;text:string}|null>(null)

  // export project (segments + speakers) JSON
  const exportJSON = () => {
    const data = { media, rttm, speakers, segments, refRTTM, refSegments }
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'rttm-project.json'; a.click()
    URL.revokeObjectURL(url)
  }

  const exportRTTM = () => {
    const fileId = media?.name ? media.name.replace(/\.[^/.]+$/, '') : 'unknown'
    const lines = segments
      .slice()
      .sort((a,b)=> a.start-b.start)
      .map(seg => {
        const dur = Math.max(MIN_DUR, seg.end - seg.start)
        const label = speakers.find(s=> s.id===seg.speakerId)?.name || seg.speakerId
        // SPEAKER <file_id> <chnl> <tbeg> <tdur> <ortho> <stype> <name> <conf>
        return `SPEAKER ${fileId} 1 ${seg.start.toFixed(3)} ${dur.toFixed(3)} <NA> <NA> ${label} <NA>`
      })
      .join('\n')
    const blob = new Blob([lines+'\n'], {type:'text/plain'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${fileId || 'segments'}.rttm`; a.click()
    URL.revokeObjectURL(url)
  }

  // Waveform generation from media
  const [wavePeaks, setWavePeaks] = useState<Float32Array | null>(null)
  const [waveFailed, setWaveFailed] = useState<boolean>(false)
   useEffect(() => {
    setWaveFailed(true); // 直接标记 waveform 不可用
  }, [media?.url]);

  // Draw waveform on canvas sized to timeline width
  useEffect(()=>{
    const canvas = waveCanvasRef.current
    if(!canvas) return
    const ctx = canvas.getContext('2d')
    if(!ctx) return
    const W = Math.max(1, timelineWidth)
    const H = 56
    const dpr = (window.devicePixelRatio||1)
    canvas.width = Math.floor(W * dpr)
    canvas.height = Math.floor(H * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(1,0,0,1,0,0)
    ctx.scale(dpr, dpr)
    ctx.clearRect(0,0,W,H)
    if(!wavePeaks || wavePeaks.length===0){
      ctx.strokeStyle = '#2a3040'
      ctx.beginPath()
      ctx.moveTo(0, H/2)
      ctx.lineTo(W, H/2)
      ctx.stroke()
      return
    }
    ctx.fillStyle = '#0e1016'
    ctx.fillRect(0,0,W,H)
    const mid = H/2
    ctx.strokeStyle = '#3b82f6'
    ctx.globalAlpha = 0.7
    ctx.beginPath()
    const samples = wavePeaks.length
    for(let x=0;x<W;x++){
      const t = x / pxPerSec
      const idx = Math.min(samples-1, Math.max(0, Math.floor(t * 50)))
      const amp = wavePeaks[idx] || 0
      const h = Math.max(1, amp * (H-8))
      ctx.moveTo(x, mid - h/2)
      ctx.lineTo(x, mid + h/2)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }, [wavePeaks, timelineWidth, pxPerSec])



  useEffect(()=>{
    if(refSegments.length===0 || segments.length===0){ setDerOverlay([]); setMetrics(null); return }
    const { intervals, metrics } = computeDER(refSegments, segments)
    setDerOverlay(intervals)
    setMetrics(metrics)
  }, [refSegments, segments])

  return (
    <div style={{display:'flex', flexDirection:'column', height:'100%'}}>
      {/* App Bar */}
      <div className="appbar">
        <div className="logo">
          <a
            className="badge github"
            href="https://github.com/DURUII/rttm-visualizer"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open GitHub repository"
            title="GitHub"
          >
            <Github size={18} />
          </a>
          <div className="title">{title}</div>
        </div>
        <div className="row">
          <button className="btn" onClick={exportRTTM}><Download className="file-icon" />导出RTTM</button>
          <button className="btn" onClick={exportJSON}><Download className="file-icon" />导出工程JSON</button>
          <button className="btn" onClick={()=> setLeftCollapsed(v=>!v)}>{leftCollapsed? 'Show Left' : 'Hide Left'}</button>
          <button className="btn" onClick={()=> setRightCollapsed(v=>!v)}>{rightCollapsed? 'Show Right' : 'Hide Right'}</button>
        </div>
      </div>

      <div className="layout">
        {/* Left panel: uploads and DER */}
        <div className={"panel section" + (leftCollapsed ? ' collapsed' : '')}
          onDragOver={(e)=>{e.preventDefault(); setDragOver(true)}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={onDrop}
        >
          {!leftCollapsed && null}

          <div className="section" onDragOver={(e)=>{e.preventDefault(); setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={(e)=>{ e.preventDefault(); setDragOver(false); if(e.dataTransfer.files) handleFiles(Array.from(e.dataTransfer.files), 'sys') }}>
            <div className="card">
              <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                <div style={{fontWeight:700}}>Media</div>
                <button className="btn" onClick={()=> mediaInputRef.current?.click()}><Upload className="file-icon"/>Upload</button>
                <input ref={mediaInputRef} type="file" style={{display:'none'}} accept=".mp4,.webm,.mp3,.wav,.m4a"
                  onChange={e=> e.target.files && handleFiles(Array.from(e.target.files))} />
              </div>
              {media ? (
                <div className="file-list-item">
                  {media.type==='video' ? <FileVideo className="file-icon"/> : <FileAudio className="file-icon"/>}
                  <div style={{overflow:'hidden'}}>
                    <div style={{fontSize:14, whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden'}}>{media.name}</div>
                    <div className="badge-sm">{duration? formatTime(duration): '--:--'}</div>
                  </div>
                </div>
              ) : <div className="badge-sm">No media selected</div>}
            </div>
          </div>

          <div className="section" onDragOver={(e)=>{e.preventDefault(); setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={(e)=>{ e.preventDefault(); setDragOver(false); if(e.dataTransfer.files) handleFiles(Array.from(e.dataTransfer.files), 'sys') }}>
            <div className="card">
              <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                <div style={{fontWeight:700}}>RTTM</div>
                <button className="btn" onClick={()=> rttmInputRef.current?.click()}><Upload className="file-icon"/>Upload</button>
                <input ref={rttmInputRef} type="file" style={{display:'none'}} accept=".rttm"
                  onChange={e=> e.target.files && handleFiles(Array.from(e.target.files), 'sys')} />
              </div>
              {rttm ? (
                <div className="file-list-item">
                  <FileText className="file-icon"/>
                  <div style={{overflow:'hidden'}}>
                    <div style={{fontSize:14, whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden'}}>{rttm.name}</div>
                    <div className="badge-sm">Segments: {segments.length}</div>
                  </div>
                </div>
              ) : <div className="badge-sm">Drop an .rttm file</div>}
            </div>
          </div>

          <div className="section" onDragOver={(e)=>{e.preventDefault(); setDragOver(true)}} onDragLeave={()=>setDragOver(false)} onDrop={(e)=>{ e.preventDefault(); setDragOver(false); if(e.dataTransfer.files) handleFiles(Array.from(e.dataTransfer.files), 'ref') }}>
            <div className="card">
              <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                <div style={{fontWeight:700}}>Ref RTTM</div>
                <button className="btn" onClick={()=> refRttmInputRef.current?.click()}><Upload className="file-icon"/>Upload</button>
                <input ref={refRttmInputRef} type="file" style={{display:'none'}} accept=".rttm"
                  onChange={e=> e.target.files && handleFiles(Array.from(e.target.files), 'ref')} />
              </div>
              {refRTTM ? (
                <div className="file-list-item">
                  <FileText className="file-icon"/>
                  <div style={{overflow:'hidden'}}>
                    <div style={{fontSize:14, whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden'}}>{refRTTM.name}</div>
                    <div className="badge-sm">Segments: {refSegments.length} · Locked</div>
                  </div>
                </div>
              ) : <div className="badge-sm">Optional reference .rttm for DER</div>}

              {/* Inline DER inside Ref RTTM card */}
              {refRTTM && rttm && metrics && (
                <div style={{marginTop:12}}>
                  <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                    <div style={{fontWeight:700}}>DER</div>
                    <div className="row">
                      <label className="badge-sm" style={{display:'inline-flex', alignItems:'center', gap:6}}>
                        <input type="checkbox" checked={showRefTrack} onChange={e=> setShowRefTrack(e.target.checked)} /> Ref
                      </label>
                      <label className="badge-sm" style={{display:'inline-flex', alignItems:'center', gap:6}}>
                        <input type="checkbox" checked={showDER} onChange={e=> setShowDER(e.target.checked)} /> Overlay
                      </label>
                    </div>
                  </div>
                  <div className="grid two">
                    <div className="metric" title="Missed Speech: 参考有语音，系统无语音">
                      <div className="badge-sm" style={{color:'#60a5fa'}}>Missed Speech</div>
                      <div style={{fontSize:18, fontWeight:700, color:'#60a5fa'}}>{metrics.MS.toFixed(2)}%</div>
                    </div>
                    <div className="metric" title="False Alarm: 系统有语音，参考无语音">
                      <div className="badge-sm" style={{color:'#ef4444'}}>False Alarm</div>
                      <div style={{fontSize:18, fontWeight:700, color:'#ef4444'}}>{metrics.FA.toFixed(2)}%</div>
                    </div>
                    <div className="metric" title="Speaker Error: 双方都为语音但说话人不匹配">
                      <div className="badge-sm" style={{color:'#f59e0b'}}>Speaker Error Rate</div>
                      <div style={{fontSize:18, fontWeight:700, color:'#f59e0b'}}>{metrics.SER.toFixed(2)}%</div>
                    </div>
                    <div className="metric" title="DER = Missed Speech + False Alarm + Speaker Error Rate">
                      <div className="badge-sm">DER</div>
                      <div style={{fontSize:20, fontWeight:800}}>{metrics.DER.toFixed(2)}%</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          

          <div className="section">
            <div className="card">
              <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                <div style={{fontWeight:700}}>SRT</div>
                <button className="btn" onClick={()=> srtInputRef.current?.click()}><Upload className="file-icon"/>Upload</button>
                <input ref={srtInputRef} type="file" style={{display:'none'}} accept=".srt"
                  onChange={e=> e.target.files && handleFiles(Array.from(e.target.files))} />
              </div>
              {srt ? (
                <div className="file-list-item">
                  <Subtitles className="file-icon"/>
                  <div style={{overflow:'hidden'}}>
                    <div style={{fontSize:14, whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden'}}>{srt.name}</div>
                    <div className="badge-sm">Subtitles: {srt.subtitles.length}</div>
                  </div>
                </div>
              ) : <div className="badge-sm">Drop an .srt file</div>}
            </div>
          </div>
        </div>

        {/* Center content: video + controls + timeline (resizable video area, scrollable tracks) */}
        <div className="center" ref={centerRef}>
          {/* Video area */}
          <div className="section" style={{paddingBottom: 0}}>
            <div style={{height: videoAreaHeight}}>
              {media?.type === 'video' ? (
                <video ref={videoRef} src={media.url} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata}
                  style={{width:'100%', height:'100%', objectFit:'contain'}} onClick={togglePlay} controls={false} />
              ) : (
                <audio ref={videoRef} src={media?.url} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} controls={false} />
              )}
            </div>
          </div>
          {/* Resizer between video and the rest */}
          <div className="resizer" onMouseDown={onResizeMouseDown} />
          {/* Controls bar (fixed height) */}
          <div className="controls-bar">
            <button className="btn icon" title="Previous segment" onClick={jumpPrev}><SkipBack size={16}/></button>
            <button className="btn icon" title="Play/Pause" onClick={togglePlay}>{isPlaying? <Pause size={16}/> : <Play size={16}/>}</button>
            <button className="btn icon" title="Next segment" onClick={jumpNext}><SkipForward size={16}/></button>
            <div className="space" />
            {/* 添加播放速率控制 */}
            <select 
              value={playbackRate} 
              onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
              style={{ margin: '0 10px', padding: '4px', borderRadius: '4px', border: '1px solid #4b5563', background: '#1f2937', color: 'white' }}
            >
              <option value={0.25}>0.25x</option>
              <option value={0.5}>0.5x</option>
              <option value={0.75}>0.75x</option>
              <option value={1}>1x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
              <option value={3}>3x</option>
            </select>
            <button className="btn icon" title="Zoom Out" onClick={zoomOut}><ZoomOut size={16}/></button>
            <input type="range" min={0.25} max={10} step={0.05} value={zoom} onChange={e=>setZoom(+e.target.value)} />
            <button className="btn icon" title="Zoom In" onClick={zoomIn}><ZoomIn size={16}/></button>
            <div style={{width:64, textAlign:'right'}} className="badge-sm">{zoom.toFixed(2)}x</div>
          </div>

          {/* Timeline area with dynamic height */}
          <div className="timeline-wrap" style={{flex: '1 1 auto', minHeight: '200px', display:'flex', flexDirection:'column', padding: '0 12px'}}>
            <div className="timeline" style={{flex: '1 1 auto', minHeight: '200px'}} ref={waveRef} onClick={onClickTimeline}
              onPointerDown={onTimelinePointerDown}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
            >
              {/* RULER */}
              <div className="ruler" style={{width: '100%', minWidth: timelineWidth}}>
                {Array.from({length: Math.ceil((duration||0)/timeDivision)}).map((_,i)=>{
                  const time = i * timeDivision
                  const left = time * pxPerSec
                  const major = i % 5 === 0
                  // 避免最后一个标签挤出边界
                  const isLastLabel = time >= (duration||0) - timeDivision * 0.5
                  return (
                    <div key={`major-${i}`}>
                      <div className="tick" style={{left, height: '100%', opacity: 1}}></div>
                      {major && !isLastLabel && <div className="label" style={{left}}>{formatHMSms(time)}</div>}
                    </div>
                  )
                })}
                {/* 最后时间标签，右对齐 */}
                {duration && duration > 0 && (
                  <div className="label" style={{right: 0, transform: 'translateX(0)'}}>{formatHMSms(duration)}</div>
                )}
                {(()=>{
                  const minorDiv = timeDivision/5
                  if (minorDiv <= 0) return null
                  const arr = Array.from({length: Math.ceil((duration||0)/minorDiv)})
                  return arr.map((_,i)=>{
                    const time = i * minorDiv
                    const left = time * pxPerSec
                    const isMajorAligned = Math.abs(time % timeDivision) < 1e-6
                    if (isMajorAligned) return null
                    return (
                      <div key={`minor-${i}`} className="tick" style={{left, height: '40%', opacity: 0.4}}></div>
                    )
                  })
                })()}
              </div>
              {/* Full-height playhead spanning ruler and tracks */}
              <div className="playhead" style={{left: `${currentTime * pxPerSec}px`}} />

              {/* Waveform */}
              <div className="wave" style={{width: '100%', minWidth: timelineWidth}}>
                <canvas ref={waveCanvasRef} />
                {waveFailed && (
                  <div className="badge-sm" style={{position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center'}}>Waveform unavailable</div>
                )}
              </div>

              {/* Tracks container fills remaining height */}
              {/* Tracks container fills remaining height */}
              <div className="tracks" style={{ 
                width: '100%', 
                minWidth: timelineWidth, 
                flex: '1 1 auto', 
                display: 'flex', 
                flexDirection: 'column',
                position: 'relative' // 用于 DER overlay 定位
              }}>
                {/* 可滚动的轨道容器 */}
                <div
                  style={{
                    flex: 'none',
                    overflowY: 'auto',
                    paddingRight: '8px',
                    maxHeight: '40vh',
                  }}
                >
                  {allTracks.map(spk => {
                    const hidden = speakers.length > 0 ? !spk.visible : false
                    return (
                      <div
                        key={spk.id}
                        className="track"
                        title={spk.name} // 👈 悬停显示说话人名
                        style={{
                          width: '100%',
                          minWidth: timelineWidth,
                          height: 28,
                          background: '#121624',
                          border: '1px solid #20263a',
                          borderTop: 'none',
                          opacity: hidden ? 0.3 : 1,
                          boxSizing: 'border-box',
                          cursor: 'default'
                        }}
                        onMouseMove={(e) => {
                          if (speakers.length === 0) return
                          if ((e.target as HTMLElement).closest('.seg')) return
                          const t = toTimeFromClientX(e.clientX)
                          const dur = 0.2
                          const start = Math.max(0, Math.min((duration || 0) - dur, t - dur / 2))
                          const end = Math.min(duration || start + dur, start + dur)
                          setGhostSeg({ speakerId: spk.id, start, end })
                        }}
                        onMouseLeave={() => setGhostSeg(null)}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest('.seg')) return
                          if (speakers.length === 0) return
                          let t = toTimeFromClientX(e.clientX)
                          if (ghostSeg && ghostSeg.speakerId === spk.id) { t = ghostSeg.start }
                          const newId = createSegmentAt(spk.id, t)
                          setSelectedSegId(newId)
                        }}
                      >
                        {ghostSeg && ghostSeg.speakerId === spk.id && (
                          <div
                            className="seg ghost"
                            style={{
                              left: ghostSeg.start * pxPerSec,
                              width: (ghostSeg.end - ghostSeg.start) * pxPerSec
                            }}
                          />
                        )}
                        {speakers.length > 0 ?
                          segments.filter(s => s.speakerId === spk.id).map(seg => {
                            const left = seg.start * pxPerSec
                            const w = (seg.end - seg.start) * pxPerSec
                            const isActive = currentTime >= seg.start && currentTime < seg.end
                            return (
                              <div
                                key={seg.id}
                                className={`seg${isActive ? ' active' : ''}${selectedSegId === seg.id ? ' selected' : ''}`}
                                style={{ left, width: w, background: spk.color }}
                                onMouseEnter={(e) => {
                                  setTooltip({
                                    x: e.clientX,
                                    y: e.clientY - 30,
                                    text: `${spk.name}  ${formatHMSms(seg.start)}–${formatHMSms(seg.end)} (${formatHMSms(seg.end - seg.start)})`
                                  })
                                }}
                                onMouseLeave={() => setTooltip(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedSegId(seg.id);
                                  seek(seg.start);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedSegId(seg.id);
                                  setCtxMenu({ x: e.clientX, y: e.clientY, segId: seg.id });
                                }}
                              >
                                <div
                                  className="handle left"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    dragRef.current = { type: 'start', speakerId: spk.id, segId: seg.id };
                                    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch {}
                                    const onMove = (ev: PointerEvent) => {
                                      const t = toTimeFromClientX(ev.clientX);
                                      setDragTip({ x: ev.clientX, y: ev.clientY - 28, text: `${formatHMSms(t)} →` });
                                      updateSegmentTime(seg.id, Math.min(t, seg.end - MIN_DUR), seg.end);
                                    };
                                    const onUp = (ev: PointerEvent) => {
                                      try { (e.target as Element).releasePointerCapture?.((ev as any).pointerId) } catch {}
                                      dragRef.current = null; setDragTip(null);
                                      window.removeEventListener('pointermove', onMove);
                                      window.removeEventListener('pointerup', onUp);
                                    };
                                    window.addEventListener('pointermove', onMove);
                                    window.addEventListener('pointerup', onUp);
                                  }}
                                />
                                <div
                                  className="handle right"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    dragRef.current = { type: 'end', speakerId: spk.id, segId: seg.id };
                                    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch {}
                                    const onMove = (ev: PointerEvent) => {
                                      const t = toTimeFromClientX(ev.clientX);
                                      setDragTip({ x: ev.clientX, y: ev.clientY - 28, text: `← ${formatHMSms(t)}` });
                                      updateSegmentTime(seg.id, seg.start, Math.max(t, seg.start + MIN_DUR));
                                    };
                                    const onUp = (ev: PointerEvent) => {
                                      try { (e.target as Element).releasePointerCapture?.((ev as any).pointerId) } catch {}
                                      dragRef.current = null; setDragTip(null);
                                      window.removeEventListener('pointermove', onMove);
                                      window.removeEventListener('pointerup', onUp);
                                    };
                                    window.addEventListener('pointermove', onMove);
                                    window.addEventListener('pointerup', onUp);
                                  }}
                                />
                              </div>
                            );
                          }) :
                          <div style={{
                            position: 'absolute',
                            left: '10px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            color: '#6B7280',
                            fontSize: '12px'
                          }}>
                            Empty track
                          </div>
                        }
                      </div>
                    );
                  })}

                  {/* Reference track overlay (locked, gray) */}
                  {showRefTrack && refSegments.length > 0 && (
                    <div
                      className="track"
                      style={{
                        width: '100%',
                        minWidth: timelineWidth,
                        height: 28,
                        background: '#0f121b',
                        border: '1px solid #20263a',
                        borderTop: 'none',
                        boxSizing: 'border-box'
                      }}
                    >
                      {refSegments.map(seg => {
                        const left = seg.start * pxPerSec
                        const w = (seg.end - seg.start) * pxPerSec
                        return (
                          <div
                            key={'ref-' + seg.id}
                            className={'seg'}
                            style={{ left, width: w, background: '#6b7280', opacity: 0.5 }}
                            onMouseEnter={(e) => {
                              setTooltip({
                                x: e.clientX,
                                y: e.clientY - 30,
                                text: `REF ${seg.speakerId}  ${formatHMSms(seg.start)}–${formatHMSms(seg.end)}`
                              });
                            }}
                            onMouseLeave={() => setTooltip(null)}
                          />
                        );
                      })}
                      <div className="badge-sm" style={{ position: 'absolute', left: 6, top: 6, color: '#cbd5e1' }}>Reference</div>
                    </div>
                  )}
                </div>

                {/* DER overlay (覆盖整个 tracks 区域) */}
                {showDER && derOverlay.length > 0 && (
                  <div
                    className="der-overlay"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      pointerEvents: 'none'
                    }}
                  >
                    {derOverlay.map((iv, idx) => {
                      if (iv.type === 'OK') return null;
                      const left = iv.start * pxPerSec;
                      const w = Math.max(1, (iv.end - iv.start) * pxPerSec);
                      const color = iv.type === 'MS' ? '#60a5fa' : iv.type === 'FA' ? '#ef4444' : '#f59e0b';
                      return (
                        <div
                          key={idx}
                          className={`der-chunk ${iv.type.toLowerCase()}`}
                          style={{
                            position: 'absolute',
                            left,
                            width: w,
                            top: 0,
                            bottom: 0,
                            background: color,
                            opacity: 0.18
                          }}
                          onMouseEnter={(e) =>
                            setTooltip({
                              x: e.clientX,
                              y: e.clientY - 30,
                              text: `${iv.type}  ${formatHMSms(iv.start)}–${formatHMSms(iv.end)} (${formatHMSms(iv.end - iv.start)})`
                            })
                          }
                          onMouseLeave={() => setTooltip(null)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {tooltip && (
              <div style={{position:'fixed', left: tooltip.x, top: tooltip.y, background:'#111827', border:'1px solid #374151', padding:'6px 8px', borderRadius:6, fontSize:12, pointerEvents:'none'}}>
                {tooltip.text}
              </div>
            )}
            {dragTip && (
              <div style={{position:'fixed', left: dragTip.x, top: dragTip.y, background:'#0b1220', border:'1px solid #2a3040', padding:'6px 8px', borderRadius:6, fontSize:12, pointerEvents:'none'}}>
                {dragTip.text}
              </div>
            )}
            {ctxMenu && (
              <div className="context-menu" style={{left: ctxMenu.x, top: ctxMenu.y}} onClick={(e)=> e.stopPropagation()}>
                <button className="menu-item" onClick={()=>{ setConfirmDelete({open:true, segId: ctxMenu.segId}); setCtxMenu(null) }}>删除</button>
                <button className="menu-item" onClick={()=> setCtxMenu(null)}>取消</button>
              </div>
            )}
          </div>
        </div>

        {/* Right panel: legend and subtitles (collapsible) */}
        <div className={"panel right section" + (rightCollapsed ? ' collapsed' : '')}>
          {!rightCollapsed && (
            <div style={{display:'grid', gridTemplateRows: (hasRTTM && hasSRT) ? '4fr 6fr' : '1fr', gap:16, height:'100%'}}>
              {hasRTTM && (
                                 <div className="card fade-in" style={{minHeight:0, overflowY:'auto'}}>
                  <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                    <div style={{fontWeight:700}}>Speakers</div>
                    <button className="btn" onClick={()=>{
                      const idx = speakers.length+1
                      const palette = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899','#14B8A6','#F472B6']
                      const color = palette[(idx-1)%palette.length]
                      const id = `speaker${idx}`
                      setSpeakers(prev => [...prev, {id, name: id, color, visible: true}])
                    }}><Plus size={14}/>添加</button>
                  </div>
                  <div className="grid" >
                    {speakers.length===0 && <div className="badge-sm">No RTTM loaded</div>}
                    {speakers.map(spk=> (
                      <div key={spk.id} className={'legend-item ' + (spk.visible? '' : 'hidden')}>
                        <input type="color" value={spk.color} onChange={e=> setSpeakers(speakers.map(s=> s.id===spk.id? {...s, color: e.target.value}: s))} style={{width:24, height:24, border:'none', background:'transparent', padding:0}}/>
                        <input value={spk.name} onChange={e=> setSpeakers(speakers.map(s=> s.id===spk.id? {...s, name: e.target.value}: s))}
                          style={{flex:1, minWidth:0, background:'#0f141b', border:'1px solid var(--border)', color:'var(--text)', borderRadius:6, padding:'6px 8px'}} />
                        <button className="btn icon" title={spk.visible? '隐藏' : '显示'} onClick={()=> setSpeakers(speakers.map(s=> s.id===spk.id? {...s, visible: !s.visible}: s))}>
                          {spk.visible ? <Eye size={14}/> : <EyeOff size={14}/>}
                        </button>
                        <button className="btn icon" title="删除" onClick={()=>{
                          setSpeakers(prev => prev.filter(s=> s.id!==spk.id))
                          setSegments(prev => prev.filter(seg=> seg.speakerId!==spk.id))
                        }}><Trash2 size={14}/></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Subtitles Preview */}
              {hasSRT && (
              <div className="card fade-in" style={{minHeight:0, display:'flex', flexDirection:'column'}}>
                <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                  <div style={{fontWeight:700}}>Subtitles</div>
                  {srt && (
                    <input
                      value={subtitleQuery}
                      onChange={e=>setSubtitleQuery(e.target.value)}
                      placeholder="Search subtitles..."
                      style={{
                        flex:1,
                        marginLeft:8,
                        background:'#0f141b',
                        border:'1px solid var(--border)',
                        color:'var(--text)',
                        borderRadius:8,
                        padding:'6px 8px',
                        minWidth:0
                      }}
                    />
                  )}
                </div>
                {!srt ? (
                  <div className="badge-sm">No .srt loaded</div>
                ) : (
                  <div ref={aroundListRef} style={{flex:1, minHeight:0, overflow:'auto', display:'grid', gap:10}}>
                    {visibleSubtitles.map((sub) => {
                      const isCurrent = currentSubtitle?.id === sub.id
                      return (
                        <div key={sub.id} className={`sub-item${isCurrent ? ' current' : ''}`} style={{
                          background: isCurrent ? '#1F2937' : '#111827',
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          opacity: isCurrent ? 1 : 0.85,
                          cursor: 'pointer'
                        }} onClick={()=>seek(sub.start)} title={`${formatTime(sub.start)} - ${formatTime(sub.end)}`}>
                          <div style={{fontSize: 12, color: '#9aa4b2', marginBottom: 6}}>
                            {formatTime(sub.start)} - {formatTime(sub.end)}
                          </div>
                          <div style={{whiteSpace:'pre-wrap', fontSize: 14, lineHeight: 1.4}}>{sub.text}</div>
                        </div>
                      )
                    })}
                    {visibleSubtitles.length === 0 && (
                      <div style={{color: '#6B7280', fontSize: 14, textAlign: 'center', padding: '20px 0'}}>
                        No subtitles
                      </div>
                    )}
                  </div>
                )}
              </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Delete confirmation modal */}
      {confirmDelete?.open && (
        <div className="modal-backdrop" onClick={()=> setConfirmDelete(null)}>
          <div className="modal" onClick={(e)=> e.stopPropagation()}>
            <div style={{fontWeight:700, marginBottom:8}}>确认删除</div>
            <div className="badge-sm" style={{marginBottom:12}}>删除后该时间段将被移除（可撤销）。</div>
            <div className="row" style={{justifyContent:'flex-end', gap:8}}>
              <button className="btn" onClick={()=> setConfirmDelete(null)}>取消</button>
              <button className="btn primary" autoFocus onClick={()=>{ if(confirmDelete) removeTimeSegment(confirmDelete.segId); setConfirmDelete(null) }}>删除</button>
            </div>
          </div>
        </div>
      )}
      {/* Undo toast */}
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.onAction && (
            <button className="link" onClick={toast.onAction}>{toast.actionLabel || '操作'}</button>
          )}
        </div>
      )}
    </div>
  )
}
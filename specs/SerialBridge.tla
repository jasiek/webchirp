---------------------------- MODULE SerialBridge ----------------------------
(***************************************************************************)
(* The port lifecycle of SerialBridge (web/js/serial-bridge.ts).           *)
(*                                                                         *)
(* What is modelled is where the code awaits, because that is where other  *)
(* work interleaves. Each action below is one stretch of JavaScript that   *)
(* runs without an await, named after the method it belongs to.            *)
(*                                                                         *)
(* The actors:                                                             *)
(*   - the caller: the one Python thread. Every bridge call reaches the    *)
(*     bridge through serial-globals.ts from that thread, one at a time;   *)
(*     cstack is its JavaScript call stack across the awaits;              *)
(*   - the read loops (_startReadLoop), one per _takeStreams();            *)
(*   - the teardown continuations: what _teardown() still has to do after  *)
(*     its first await (wait for the loop, close the transport), whether a *)
(*     caller awaits it or it was started with void;                       *)
(*   - the environment: transport promises settling, reads failing, and    *)
(*     the device going away (and, if DeviceCanReturn, coming back).       *)
(*                                                                         *)
(* The event loop: a transport promise settling, a read failing and a      *)
(* disconnect event are macrotasks, so they happen only when no            *)
(* continuation is runnable (~Busy). Continuations (microtasks) may run in *)
(* any order among themselves, which over-approximates FIFO order.         *)
(*                                                                         *)
(* Left out: bytes, waiters and timeouts (readBytes and inWaiting are      *)
(* modelled only by the port check they start with), option values, and   *)
(* one physical device seen through two port objects: every port object    *)
(* requestTransport() hands out is a fresh one.                            *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Ports,           \* the port objects requestTransport() can hand out
    NoPort,          \* null
    MaxCalls,        \* how many bridge calls the caller makes
    Route,           \* the port's capabilities.reconfigure: "reopen" or "update"
    DeviceCanReturn  \* whether a device that went away can come back

ASSUME NoPort \notin Ports
ASSUME Route \in {"reopen", "update"}
ASSUME DeviceCanReturn \in BOOLEAN
ASSUME MaxCalls \in Nat

VARIABLES
    \* The bridge's fields.
    port,       \* this.port
    reader,     \* this.reader and this.writer (always set and cleared together),
                \* as the index of the read loop that owns the reader, or 0
    hasOpts,    \* this.portOptions !== null
    announced,  \* this._announcedOpen
    watching,   \* the port this._stopLossWatch unsubscribes from
    \* The transports.
    phys,       \* each port object's state
    armed,      \* each port's disconnect notifier (createDisconnectNotifier)
    opResult,   \* the outcome of each port's last open()
    reconf,     \* each port's in-place reconfigure(), for Route "update"
    device,     \* "present" or "gone"
    \* Continuations.
    loops,      \* the read loops, oldest first
    tasks,      \* the teardown continuations, oldest first
    \* The caller.
    cpc,        \* where it is
    cstack,     \* the frames it returns or throws to
    cport,      \* the local `port` of open() and _reopenPort()
    cgen,       \* the read loop _reopenPort() waits for
    ctask,      \* the teardown the caller is awaiting
    calls,      \* calls made so far
    resumed,    \* the caller has just returned and no macrotask has run since
    \* History, for the properties.
    reports,    \* onPortLost reports since the caller was last told "open"
    typeError,  \* a method dereferenced a null this.port
    wroteUnheld \* writeBytes() wrote to a port the bridge no longer holds

bridge    == <<port, reader, hasOpts, announced, watching>>
transport == <<phys, armed, opResult, reconf, device>>
async     == <<loops, tasks>>
caller    == <<cpc, cstack, cport, cgen, ctask, calls>>
ghost     == <<reports, typeError, wroteUnheld>>
vars      == <<bridge, transport, async, caller, ghost, resumed>>

PhysStates == {"fresh", "opening", "open", "closing", "closed"}

TypeOK ==
    /\ port \in Ports \cup {NoPort}
    /\ watching \in Ports \cup {NoPort}
    /\ reader \in 0..Len(loops)
    /\ hasOpts \in BOOLEAN
    /\ announced \in BOOLEAN
    /\ phys \in [Ports -> PhysStates]
    /\ armed \in [Ports -> BOOLEAN]
    /\ opResult \in [Ports -> {"none", "ok", "fail"}]
    /\ reconf \in [Ports -> {"none", "pending", "ok", "fail"}]
    /\ device \in {"present", "gone"}
    /\ \A g \in 1..Len(loops) :
          /\ loops[g].port \in Ports
          /\ loops[g].st \in {"reading", "cancelling", "end", "done"}
    /\ \A k \in 1..Len(tasks) :
          /\ tasks[k].port \in Ports \cup {NoPort}
          /\ tasks[k].gen \in 0..Len(loops)
          /\ tasks[k].st \in {"awaitLoop", "closing", "done"}
    /\ calls \in 0..MaxCalls
    /\ reports \in Nat

Init ==
    /\ port = NoPort /\ reader = 0 /\ hasOpts = FALSE
    /\ announced = FALSE /\ watching = NoPort
    /\ phys = [p \in Ports |-> "fresh"]
    /\ armed = [p \in Ports |-> FALSE]
    /\ opResult = [p \in Ports |-> "none"]
    /\ reconf = [p \in Ports |-> "none"]
    /\ device = "present"
    /\ loops = <<>> /\ tasks = <<>>
    /\ cpc = "idle" /\ cstack = <<>> /\ cport = NoPort
    /\ cgen = 0 /\ ctask = 0 /\ calls = 0
    /\ resumed = FALSE
    /\ reports = 0 /\ typeError = FALSE /\ wroteUnheld = FALSE

-----------------------------------------------------------------------------
(* Shared pieces.                                                          *)

\* No read loop to wait for, or it has returned. An IF, not a disjunction:
\* TLC tries both sides of a disjunction inside an action.
LoopDone(g) == IF g = 0 THEN TRUE ELSE loops[g].st = "done"

\* reader.cancel(): the pending read will settle (a macrotask).
Cancel(ls, g) ==
    IF g # 0 /\ ls[g].st = "reading" THEN [ls EXCEPT ![g].st = "cancelling"] ELSE ls

\* _teardown() up to its first await: everything the bridge holds is let go
\* of, and the rest -- await the loop, then port.close() -- becomes a task.
TeardownPrefix ==
    /\ port' = NoPort /\ reader' = 0 /\ hasOpts' = FALSE /\ watching' = NoPort
    /\ loops' = Cancel(loops, reader)
    /\ tasks' = Append(tasks, [st |-> "awaitLoop", port |-> port, gen |-> reader])

\* The index of the task TeardownPrefix appends.
NewTask == Len(tasks) + 1

\* _reportPortLost().
Report ==
    /\ announced' = FALSE
    /\ reports' = IF announced THEN reports + 1 ELSE reports

\* A read loop started on `p` by _takeStreams(): its while condition is
\* checked before the first read, so it ends at once on a port not held.
NewLoop(p) == [port |-> p, st |-> IF port = p THEN "reading" ELSE "done"]

Call(proc, ok, err) ==
    /\ cpc' = proc
    /\ cstack' = <<[ok |-> ok, err |-> err]>> \o cstack
Return == cpc' = Head(cstack).ok /\ cstack' = Tail(cstack)
Throw  == cpc' = Head(cstack).err /\ cstack' = Tail(cstack)

\* this._notConnected() and the throw of the error it returns.
NotConnectedThrow ==
    /\ Throw
    /\ \/ /\ announced /\ port # NoPort
          /\ TeardownPrefix /\ Report        \* void this._losePort(info)
          /\ UNCHANGED <<transport, cport, cgen, ctask, calls, typeError, wroteUnheld>>
       \/ /\ announced /\ port = NoPort
          /\ Report
          /\ UNCHANGED <<port, reader, hasOpts, watching, transport, async,
                         cport, cgen, ctask, calls, typeError, wroteUnheld>>
       \/ /\ ~announced
          /\ UNCHANGED <<bridge, transport, async, cport, cgen, ctask, calls, ghost>>

\* Stepping to another label of the same method, nothing else changing.
Goto(l) ==
    /\ cpc' = l
    /\ UNCHANGED <<bridge, transport, async, cstack, cport, cgen, ctask, calls, ghost>>

KeepAllButStack == UNCHANGED <<bridge, transport, async, cport, cgen, ctask, calls, ghost>>

AwaitingTeardown == {"open_td", "open_fail_td", "close_td", "ab_fail_td", "rc_lose_td"}

-----------------------------------------------------------------------------
(* The caller.                                                             *)

\* The Python thread makes its next bridge call.
CallerStarts ==
    /\ cpc = "idle" /\ calls < MaxCalls
    /\ \E op \in {"open", "close", "prep", "reconf", "write", "read"} :
          /\ cpc' = op
          /\ cstack' = <<[ok |-> "idle", err |-> "idle"]>>
    /\ calls' = calls + 1
    /\ UNCHANGED <<bridge, transport, async, cport, cgen, ctask, ghost>>

\* Any `await this._teardown()` or `await this._losePort()`.
TeardownDone ==
    /\ cpc \in AwaitingTeardown
    /\ tasks[ctask].st = "done"
    /\ CASE cpc = "open_td" -> Goto("open_req")
         [] cpc = "close_td" -> Return /\ KeepAllButStack
         [] OTHER -> Throw /\ KeepAllButStack

\* open(baudRate)
Open ==
    /\ cpc = "open"
    /\ \/ /\ port # NoPort /\ reader # 0          \* reuse the held port
          /\ Call("ab", "open_reuse", "rethrow")
          /\ KeepAllButStack
       \/ /\ port # NoPort /\ reader = 0          \* half-open: tear it down first
          /\ announced' = FALSE
          /\ TeardownPrefix /\ ctask' = NewTask /\ cpc' = "open_td"
          /\ UNCHANGED <<transport, cstack, cport, cgen, calls, ghost>>
       \/ /\ port = NoPort
          /\ announced' = FALSE /\ cpc' = "open_req"
          /\ UNCHANGED <<port, reader, hasOpts, watching, transport, async,
                         cstack, cport, cgen, ctask, calls, ghost>>

\* await this.requestTransport(), then port.open(options).
OpenRequest ==
    /\ cpc = "open_req"
    /\ \/ \E p \in Ports :
             /\ phys[p] = "fresh"
             /\ port' = p /\ cport' = p
             /\ phys' = [phys EXCEPT ![p] = "opening"]
             /\ opResult' = [opResult EXCEPT ![p] = "none"]
             /\ cpc' = "open_wait"
             /\ UNCHANGED <<reader, hasOpts, announced, watching, armed, reconf, device,
                            async, cstack, cgen, ctask, calls, ghost>>
       \/ /\ Throw /\ KeepAllButStack            \* the chooser was dismissed

\* await port.open(options) settled.
OpenSettled ==
    /\ cpc = "open_wait"
    /\ opResult[cport] # "none"
    /\ IF opResult[cport] = "ok" /\ phys[cport] = "open"
       THEN /\ hasOpts' = TRUE
            /\ reader' = Len(loops) + 1             \* _takeStreams(port)
            /\ loops' = Append(loops, NewLoop(cport))
            /\ watching' = cport                    \* _watchForPortLoss(port)
            /\ announced' = TRUE /\ reports' = 0
            /\ Return
            /\ UNCHANGED <<port, transport, tasks, cport, cgen, ctask, calls,
                           typeError, wroteUnheld>>
       ELSE /\ TeardownPrefix /\ ctask' = NewTask /\ cpc' = "open_fail_td"
            /\ UNCHANGED <<announced, transport, cstack, cport, cgen, calls, ghost>>

\* After `await this.applyBaudRate(baudRate)` on the reuse path.
OpenReused ==
    /\ cpc = "open_reuse"
    /\ announced' = TRUE
    /\ reports' = IF announced THEN reports ELSE 0
    /\ Return
    /\ UNCHANGED <<port, reader, hasOpts, watching, transport, async,
                   cport, cgen, ctask, calls, typeError, wroteUnheld>>

\* An awaited call threw: the await rethrows it one microtask later.
Rethrow == cpc = "rethrow" /\ Throw /\ KeepAllButStack

\* close()
Close ==
    /\ cpc = "close"
    /\ announced' = FALSE
    /\ \/ /\ port = NoPort /\ Return
          /\ UNCHANGED <<port, reader, hasOpts, watching, transport, async,
                         cport, cgen, ctask, calls, ghost>>
       \/ /\ port # NoPort
          /\ TeardownPrefix /\ ctask' = NewTask /\ cpc' = "close_td"
          /\ UNCHANGED <<transport, cstack, cport, cgen, calls, ghost>>

\* applyBaudRate(baudRate)
ApplyBaudRate ==
    /\ cpc = "ab"
    /\ IF port = NoPort \/ reader = 0
       THEN NotConnectedThrow
       ELSE /\ \/ Return                            \* already at those settings
               \/ Call("rp", "ab_ok", "ab_fail")    \* await this._reopenPort(target)
            /\ KeepAllButStack

ApplyBaudRateDone == cpc = "ab_ok" /\ Return /\ KeepAllButStack

\* The reopen failed: await this._losePort({reason: BAUD_RATE_CHANGE}).
ApplyBaudRateLose ==
    /\ cpc = "ab_fail"
    /\ TeardownPrefix /\ Report
    /\ ctask' = NewTask /\ cpc' = "ab_fail_td"
    /\ UNCHANGED <<transport, cstack, cport, cgen, calls, typeError, wroteUnheld>>

\* _reopenPort(nextOptions)
Reopen ==
    /\ cpc = "rp"
    /\ IF port = NoPort
       THEN Throw /\ KeepAllButStack
       ELSE IF Route = "update"
       THEN /\ cport' = port                        \* await port.reconfigure(next)
            /\ reconf' = [reconf EXCEPT ![port] = "pending"]
            /\ cpc' = "rp_upd"
            /\ UNCHANGED <<bridge, phys, armed, opResult, device, async,
                           cstack, cgen, ctask, calls, ghost>>
       ELSE /\ cport' = port                        \* await this._releaseStreams()
            /\ cgen' = reader
            /\ reader' = 0
            /\ loops' = Cancel(loops, reader)
            /\ cpc' = "rp_rel"
            /\ UNCHANGED <<port, hasOpts, announced, watching, transport, tasks,
                           cstack, ctask, calls, ghost>>

\* Route "update": await port.reconfigure(next) settled.
ReopenUpdated ==
    /\ cpc = "rp_upd"
    /\ reconf[cport] \in {"ok", "fail"}
    /\ reconf' = [reconf EXCEPT ![cport] = "none"]
    /\ IF reconf[cport] = "ok"
       THEN hasOpts' = TRUE /\ Return               \* this.portOptions = nextOptions
       ELSE hasOpts' = hasOpts /\ Throw
    /\ UNCHANGED <<port, reader, announced, watching, phys, armed, opResult, device,
                   async, cport, cgen, ctask, calls, ghost>>

\* Route "reopen": the streams are released; port.close().
ReopenReleased ==
    /\ cpc = "rp_rel"
    /\ LoopDone(cgen)
    /\ IF phys[cport] = "open"
       THEN /\ phys' = [phys EXCEPT ![cport] = "closing"]
            /\ armed' = [armed EXCEPT ![cport] = FALSE]   \* disarmed as close starts
       ELSE UNCHANGED <<phys, armed>>                     \* close() rejects; ignored
    /\ cpc' = "rp_close"
    /\ UNCHANGED <<bridge, opResult, reconf, device, async,
                   cstack, cport, cgen, ctask, calls, ghost>>

\* The close settled (or was refused): port.open(nextOptions).
ReopenClosed ==
    /\ cpc = "rp_close"
    /\ phys[cport] # "closing"
    /\ IF phys[cport] = "closed"
       THEN /\ phys' = [phys EXCEPT ![cport] = "opening"]
            /\ opResult' = [opResult EXCEPT ![cport] = "none"]
            /\ cpc' = "rp_open" /\ UNCHANGED cstack
       ELSE /\ Throw /\ UNCHANGED <<phys, opResult>>
    /\ UNCHANGED <<bridge, armed, reconf, device, async, cport, cgen, ctask, calls, ghost>>

\* await port.open(nextOptions) settled: take the streams of the local `port`.
ReopenOpened ==
    /\ cpc = "rp_open"
    /\ opResult[cport] # "none"
    /\ IF opResult[cport] = "ok" /\ phys[cport] = "open"
       THEN /\ hasOpts' = TRUE
            /\ reader' = Len(loops) + 1
            /\ loops' = Append(loops, NewLoop(cport))
            /\ Return
       ELSE /\ UNCHANGED <<hasOpts, reader, loops>>
            /\ Throw
    /\ UNCHANGED <<port, announced, watching, transport, tasks,
                   cport, cgen, ctask, calls, ghost>>

\* prepareClone(...)
Prepare ==
    /\ cpc = "prep"
    /\ IF port = NoPort
       THEN NotConnectedThrow
       ELSE Call("ab", "prep_reset", "rethrow") /\ KeepAllButStack

\* await this.resetBuffers(): a microtask in the browser.
PrepareReset == cpc = "prep_reset" /\ Goto("prep_sig")

\* this.port.capabilities.signals, then await this.port.setSignals(...).
PrepareSignals ==
    /\ cpc = "prep_sig"
    /\ IF port = NoPort
       THEN typeError' = TRUE /\ Throw              \* TypeError: this.port is null
       ELSE typeError' = typeError /\ cpc' = "prep_settle" /\ UNCHANGED cstack
    /\ UNCHANGED <<bridge, transport, async, cport, cgen, ctask, calls,
                   reports, wroteUnheld>>

\* reconfigure(options)
Reconfigure ==
    /\ cpc = "reconf"
    /\ IF port = NoPort \/ ~hasOpts
       THEN NotConnectedThrow
       ELSE /\ \/ Return                            \* nothing changed
               \/ Throw                             \* framing the port cannot carry
               \/ Call("rp", "rc_ok", "rc_fail")
            /\ KeepAllButStack

\* await this._restoreSignals(), after a reopen that worked.
ReconfigureDone == cpc = "rc_ok" /\ Return /\ KeepAllButStack

\* The change failed: put the old settings back.
ReconfigureRestore ==
    /\ cpc = "rc_fail"
    /\ Call("rp", "rc_restored", "rc_lose")
    /\ KeepAllButStack

ReconfigureRestored == cpc = "rc_restored" /\ Throw /\ KeepAllButStack

\* Even that failed: await this._losePort({reason: RECONFIGURE}).
ReconfigureLose ==
    /\ cpc = "rc_lose"
    /\ TeardownPrefix /\ Report
    /\ ctask' = NewTask /\ cpc' = "rc_lose_td"
    /\ UNCHANGED <<transport, cstack, cport, cgen, calls, typeError, wroteUnheld>>

\* writeBytes(): checks this.writer only.
Write ==
    /\ cpc = "write"
    /\ IF reader = 0
       THEN NotConnectedThrow
       ELSE /\ wroteUnheld' = (wroteUnheld \/ port = NoPort)
            /\ Return
            /\ UNCHANGED <<bridge, transport, async, cport, cgen, ctask, calls,
                           reports, typeError>>

\* readBytes(), inWaiting(), setSignals(): check this.port.
Read ==
    /\ cpc = "read"
    /\ IF port = NoPort THEN NotConnectedThrow ELSE Return /\ KeepAllButStack

\* The caller can take a step now (it is not waiting on I/O).
CallerRunnable ==
    /\ cpc \notin {"idle", "prep_settle"}
    /\ CASE cpc \in AwaitingTeardown -> tasks[ctask].st = "done"
         [] cpc \in {"open_wait", "rp_open"} -> opResult[cport] # "none"
         [] cpc = "rp_upd" -> reconf[cport] \in {"ok", "fail"}
         [] cpc = "rp_rel" -> LoopDone(cgen)
         [] cpc = "rp_close" -> phys[cport] # "closing"
         [] OTHER -> TRUE

CallerContinues ==
    /\ CallerRunnable
    /\ \/ TeardownDone \/ Open \/ OpenRequest \/ OpenSettled \/ OpenReused
       \/ Rethrow \/ Close \/ ApplyBaudRate \/ ApplyBaudRateDone \/ ApplyBaudRateLose
       \/ Reopen \/ ReopenUpdated \/ ReopenReleased \/ ReopenClosed \/ ReopenOpened
       \/ Prepare \/ PrepareReset \/ PrepareSignals
       \/ Reconfigure \/ ReconfigureDone \/ ReconfigureRestore
       \/ ReconfigureRestored \/ ReconfigureLose
       \/ Write \/ Read
    /\ resumed' = (cpc' = "idle")

-----------------------------------------------------------------------------
(* Continuations that are not the caller's.                                *)

\* _teardown() after `await released`: port.close().
TeardownCloses(k) ==
    /\ tasks[k].st = "awaitLoop"
    /\ LoopDone(tasks[k].gen)
    /\ LET p == tasks[k].port IN
       IF p # NoPort /\ phys[p] = "open"
       THEN /\ phys' = [phys EXCEPT ![p] = "closing"]
            /\ armed' = [armed EXCEPT ![p] = FALSE]
            /\ tasks' = [tasks EXCEPT ![k].st = "closing"]
       ELSE /\ UNCHANGED <<phys, armed>>            \* no port, or close() rejects
            /\ tasks' = [tasks EXCEPT ![k].st = "done"]
    /\ UNCHANGED <<bridge, opResult, reconf, device, loops, caller, ghost>>

TeardownClosed(k) ==
    /\ tasks[k].st = "closing"
    /\ phys[tasks[k].port] # "closing"
    /\ tasks' = [tasks EXCEPT ![k].st = "done"]
    /\ UNCHANGED <<bridge, transport, loops, caller, ghost>>

TaskRunnable(k) ==
    \/ tasks[k].st = "awaitLoop" /\ LoopDone(tasks[k].gen)
    \/ tasks[k].st = "closing" /\ phys[tasks[k].port] # "closing"

\* _startReadLoop() after its read settled with done or an error.
LoopExits(g) ==
    /\ loops[g].st = "end"
    /\ loops' = [loops EXCEPT ![g].st = "done"]
    /\ IF port = loops[g].port /\ reader = g
       THEN \* stoppedUnasked: void this._losePort({reason: READ_STOPPED})
            /\ port' = NoPort /\ reader' = 0 /\ hasOpts' = FALSE /\ watching' = NoPort
            /\ tasks' = Append(tasks, [st |-> "awaitLoop", port |-> port, gen |-> g])
            /\ Report
            /\ UNCHANGED <<transport, caller, typeError, wroteUnheld>>
       ELSE UNCHANGED <<bridge, transport, tasks, caller, ghost>>

Busy ==
    \/ CallerRunnable
    \/ \E k \in 1..Len(tasks) : TaskRunnable(k)
    \/ \E g \in 1..Len(loops) : loops[g].st = "end"

-----------------------------------------------------------------------------
(* Macrotasks: they run only once no continuation is runnable.             *)

\* The settle delay at the end of prepareClone() (and its setSignals()).
PrepareSettled ==
    /\ ~Busy
    /\ cpc = "prep_settle"
    /\ Return /\ KeepAllButStack
    /\ resumed' = TRUE

OpenResolves(p) ==
    /\ ~Busy
    /\ resumed' = FALSE
    /\ phys[p] = "opening"
    /\ \/ /\ device = "present"
          /\ phys' = [phys EXCEPT ![p] = "open"]
          /\ armed' = [armed EXCEPT ![p] = TRUE]     \* notifier.arm()
          /\ opResult' = [opResult EXCEPT ![p] = "ok"]
       \/ /\ phys' = [phys EXCEPT ![p] = "closed"]
          /\ opResult' = [opResult EXCEPT ![p] = "fail"]
          /\ UNCHANGED armed
    /\ UNCHANGED <<bridge, reconf, device, async, caller, ghost>>

CloseResolves(p) ==
    /\ ~Busy
    /\ resumed' = FALSE
    /\ phys[p] = "closing"
    /\ phys' = [phys EXCEPT ![p] = "closed"]
    /\ UNCHANGED <<bridge, armed, opResult, reconf, device, async, caller, ghost>>

ReconfigureResolves(p) ==
    /\ ~Busy
    /\ resumed' = FALSE
    /\ reconf[p] = "pending"
    /\ \/ device = "present" /\ reconf' = [reconf EXCEPT ![p] = "ok"]
       \/ reconf' = [reconf EXCEPT ![p] = "fail"]
    /\ UNCHANGED <<bridge, phys, armed, opResult, device, async, caller, ghost>>

\* A pending read settles: an error, done, or a cancel taking effect.
ReadSettles(g) ==
    /\ ~Busy
    /\ resumed' = FALSE
    /\ loops[g].st \in {"reading", "cancelling"}
    /\ loops' = [loops EXCEPT ![g].st = "end"]
    /\ UNCHANGED <<bridge, transport, tasks, caller, ghost>>

\* The device goes away. Every armed notifier fires once; the bridge's
\* subscription runs _handleTransportDisconnect() up to its first await.
Unplug ==
    /\ ~Busy
    /\ resumed' = FALSE
    /\ device = "present"
    /\ device' = "gone"
    /\ armed' = [p \in Ports |-> FALSE]
    /\ IF watching # NoPort /\ armed[watching] /\ port = watching
       THEN TeardownPrefix /\ Report
       ELSE UNCHANGED <<port, reader, hasOpts, announced, watching, async, reports>>
    /\ UNCHANGED <<phys, opResult, reconf, caller, typeError, wroteUnheld>>

\* The device comes back, and the port objects it had can open again.
Replug ==
    /\ DeviceCanReturn
    /\ ~Busy
    /\ resumed' = FALSE
    /\ device = "gone"
    /\ device' = "present"
    /\ UNCHANGED <<bridge, phys, armed, opResult, reconf, async, caller, ghost>>

-----------------------------------------------------------------------------

TaskStep == (\E k \in 1..Len(tasks) : TeardownCloses(k) \/ TeardownClosed(k)) /\ UNCHANGED resumed
LoopStep == (\E g \in 1..Len(loops) : LoopExits(g)) /\ UNCHANGED resumed

\* The Python thread calls again: straight after its last call returned, as
\* that call's continuation, or later, from a macrotask (a timer, a new RPC).
\* Either way it never starts between a macrotask and the continuations that
\* macrotask queued.
CallerResumes ==
    /\ resumed \/ ~Busy
    /\ CallerStarts
    /\ resumed' = FALSE

Next ==
    \/ CallerResumes \/ CallerContinues \/ PrepareSettled
    \/ TaskStep \/ LoopStep
    \/ \E p \in Ports : OpenResolves(p) \/ CloseResolves(p) \/ ReconfigureResolves(p)
    \/ \E g \in 1..Len(loops) : ReadSettles(g)
    \/ Unplug \/ Replug

\* Code always runs on; open() and reconfigure() always settle.
Fairness ==
    /\ WF_vars(CallerContinues) /\ WF_vars(PrepareSettled)
    /\ WF_vars(TaskStep) /\ WF_vars(LoopStep)
    /\ WF_vars(\E p \in Ports : OpenResolves(p))
    /\ WF_vars(\E p \in Ports : ReconfigureResolves(p))

\* A close or a cancel settles, and a read on a device that is gone fails.
IoSettles ==
    /\ WF_vars(\E p \in Ports : CloseResolves(p))
    /\ WF_vars(\E g \in 1..Len(loops) :
                  /\ loops[g].st = "cancelling" \/ device = "gone"
                  /\ ReadSettles(g))

Spec == Init /\ [][Next]_vars /\ Fairness /\ IoSettles

\* A vanished device's close() and reader.cancel() may never settle, as the
\* comment on _teardown() says.
SpecIoCanHang == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties.                                                             *)

\* onPortLost fires at most once for each time the caller was told "open".
OneReportPerConnection == reports <= 1

\* The bridge never holds a reader or writer on a port it does not hold.
StreamsOnHeldPort == reader # 0 => (port # NoPort /\ loops[reader].port = port)

\* No method dereferences this.port after it went null across an await.
NoNullDeref == ~typeError

\* writeBytes() never writes to a port the bridge has given up.
NoWriteToUnheldPort == ~wroteUnheld

\* Nothing is left to run except reads waiting for bytes and stalled closes.
Settled ==
    /\ cpc = "idle"
    /\ \A k \in 1..Len(tasks) : tasks[k].st \in {"done", "closing"}
    /\ \A g \in 1..Len(loops) : loops[g].st \in {"reading", "done"}
    /\ \A p \in Ports : phys[p] # "opening" /\ reconf[p] = "none"

\* Once things settle, a caller told "open" is right: the backstop in
\* _notConnected() is never what tells it otherwise.
NoSilentDrop == (Settled /\ announced) => (port # NoPort /\ reader # 0)

\* Once things settle, the only open port is the one the bridge holds.
NoLeakedPort == Settled => \A p \in Ports : phys[p] = "open" => p = port

\* Every bridge call returns.
CallsReturn == [](cpc # "idle" => <>(cpc = "idle"))

\* A caller told "open" hears that the device went, without making a call.
LossReported == [](device = "gone" /\ announced => <>(~announced \/ device = "present"))

=============================================================================

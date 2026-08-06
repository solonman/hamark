"use client";

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

export type PlayerPosition = { x: number; y: number };
type PlayerSize = { width: number; height: number };
type ViewportSize = { width: number; height: number };

const CONTROL_STRIP_HEIGHT = 44;

export function clampPlayerPosition(
  position: PlayerPosition,
  player: PlayerSize,
  viewport: ViewportSize,
): PlayerPosition {
  return {
    x: Math.max(0, Math.min(position.x, Math.max(0, viewport.width - player.width))),
    y: Math.max(0, Math.min(position.y, Math.max(0, viewport.height - player.height))),
  };
}

export function isVideoControlStrip(
  offsetY: number,
  height: number,
  controlStripHeight: number,
) {
  return offsetY >= height - controlStripHeight;
}

type DragStart = {
  pointerId: number;
  x: number;
  y: number;
  playerX: number;
  playerY: number;
};

export default function DraggableVideoPlayer({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<DragStart | null>(null);

  function getPlayer() {
    return wrapperRef.current?.firstElementChild instanceof HTMLElement
      ? wrapperRef.current.firstElementChild
      : null;
  }

  function applyPosition(player: HTMLElement, position: PlayerPosition) {
    player.style.left = `${position.x}px`;
    player.style.top = `${position.y}px`;
    player.style.right = "auto";
    player.style.bottom = "auto";
  }

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    if (!enabled) {
      dragStartRef.current = null;
      wrapperRef.current?.classList.remove("is-dragging");
      player.style.left = "";
      player.style.top = "";
      player.style.right = "";
      player.style.bottom = "";
      return;
    }

    function keepPlayerInView() {
      const currentPlayer = getPlayer();
      if (!currentPlayer || !currentPlayer.style.left) return;
      const bounds = currentPlayer.getBoundingClientRect();
      applyPosition(
        currentPlayer,
        clampPlayerPosition(
          { x: bounds.left, y: bounds.top },
          { width: bounds.width, height: bounds.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    }

    window.addEventListener("resize", keepPlayerInView);
    return () => window.removeEventListener("resize", keepPlayerInView);
  }, [enabled]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!enabled || event.button !== 0) return;
    const player = getPlayer();
    const video = event.currentTarget.querySelector("video");
    if (!player || !video) return;

    const videoBounds = video.getBoundingClientRect();
    if (
      event.clientY >= videoBounds.top &&
      event.clientY <= videoBounds.bottom &&
      isVideoControlStrip(
        event.clientY - videoBounds.top,
        videoBounds.height,
        CONTROL_STRIP_HEIGHT,
      )
    ) {
      return;
    }

    const playerBounds = player.getBoundingClientRect();
    applyPosition(player, { x: playerBounds.left, y: playerBounds.top });
    dragStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      playerX: playerBounds.left,
      playerY: playerBounds.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.currentTarget.classList.add("is-dragging");
  }

  function finishDragging(event: ReactPointerEvent<HTMLDivElement>) {
    const dragStart = dragStartRef.current;
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.classList.remove("is-dragging");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragStart = dragStartRef.current;
    const player = getPlayer();
    if (!dragStart || dragStart.pointerId !== event.pointerId || !player) return;
    const bounds = player.getBoundingClientRect();
    applyPosition(
      player,
      clampPlayerPosition(
        {
          x: dragStart.playerX + event.clientX - dragStart.x,
          y: dragStart.playerY + event.clientY - dragStart.y,
        },
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }

  return (
    <div
      className={`draggable-video-player${enabled ? " is-draggable" : ""}`}
      ref={wrapperRef}
      onPointerCancel={finishDragging}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDragging}
    >
      {children}
    </div>
  );
}

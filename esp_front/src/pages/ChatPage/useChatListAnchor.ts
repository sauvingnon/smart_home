import { useCallback, useEffect, useRef, useState } from 'react';

// Насколько близко к низу лента считается "у низа". Тот же порог, что был в
// ChatPage до выделения этого хука.
const NEAR_BOTTOM_PX = 120;

// Окно, внутри которого события scroll считаются следствием жеста
// пользователя. Каждое событие скролла, пришедшее внутри окна, продлевает его
// — так инерционный скролл iOS (он продолжается секундами после touchend)
// доживает до конца одним непрерывным жестом, а scroll, порождённый
// раскладкой (клавиатура, смена padding, схлопывание пузыря), приходит вне
// окна и на режим залипания не влияет.
const GESTURE_WINDOW_MS = 300;

// Сколько ждём собственный smooth-скролл, прежде чем снова разрешить себе
// жёсткую запись scrollTop. Записать scrollTop поверх идущей smooth-анимации
// — значит оборвать её на полпути.
const SMOOTH_SCROLL_MS = 600;

/**
 * Единственный владелец scrollTop ленты сообщений.
 *
 * До этого хука в scrollTop писали четыре независимых места (автоскролл на
 * новое сообщение, ResizeObserver контента, восстановление позиции после
 * подгрузки истории, кнопка "вниз"), и ещё одно (handleScroll) переписывало
 * флаг "юзер внизу" на каждое событие scroll — включая события, которые
 * породила сама раскладка. Они гонялись друг с другом за один и тот же
 * пиксель: отсюда и прыжки, и пустоты после удаления/правки.
 *
 * Здесь два правила, и всё остальное — их следствие:
 *  1. scrollTop пишет только этот модуль.
 *  2. Режим залипания меняется только от жеста пользователя и от явных
 *     действий (кнопка "вниз"), но никогда — от изменений раскладки.
 */
export function useChatListAnchor(
  containerRef: React.RefObject<HTMLDivElement | null>,
  contentRef: React.RefObject<HTMLDivElement | null>,
) {
  // Ref, а не state: читается из обработчиков событий и из ResizeObserver,
  // где замыкание на state было бы устаревшим. Зеркалим в state ниже только
  // ради рендера кнопки "вниз".
  const stickRef = useRef(true);
  const [isStuck, setIsStuck] = useState(true);

  // Палец сейчас на ленте. Программная запись scrollTop поверх активного
  // тач-жеста на iOS — известный триггер "заморозки" слоя скролла в
  // WKWebView (тот же класс бага, что раньше ловили на backdrop-filter меню
  // действий), поэтому пока палец на экране мы только запоминаем намерение.
  const isTouchingRef = useRef(false);
  const pendingPinRef = useRef(false);

  const gestureUntilRef = useRef(0);
  const smoothUntilRef = useRef(0);

  const setStick = useCallback((next: boolean) => {
    if (stickRef.current === next) return;
    stickRef.current = next;
    setIsStuck(next);
  }, []);

  /**
   * Единственное место во всём чате, где выполняется запись scrollTop ради
   * удержания низа. Сам по себе не решает, надо ли держать низ — только
   * исполняет уже принятое решение (stickRef) и уважает три запрета:
   * палец на ленте, идущий smooth-скролл, и уже достигнутый низ.
   */
  const pin = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!stickRef.current) return;
    if (isTouchingRef.current) {
      pendingPinRef.current = true;
      return;
    }
    if (Date.now() < smoothUntilRef.current) return;
    // Уже внизу — не трогаем scrollTop вообще. Лишняя запись того же
    // значения на iOS всё равно способна сбить инерцию.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) return;
    el.scrollTop = el.scrollHeight;
  }, [containerRef]);

  /**
   * Проверка инварианта после мутации ленты: "если мы считаем, что юзер внизу,
   * то низ обязан быть у поля ввода". В 99% случаев ничего не делает.
   * Закрывает остаточную щель независимо от того, кто её оставил —
   * недоигравшее схлопывание удалённого сообщения, правка, изменившая высоту
   * пузыря, догрузившееся медиа, сменившееся состояние плеера.
   */
  const settle = pin;

  /** Явный переход вниз: кнопка "вниз" или своё отправленное сообщение. */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    setStick(true);
    if (behavior === 'smooth') smoothUntilRef.current = Date.now() + SMOOTH_SCROLL_MS;
    requestAnimationFrame(() => {
      const node = containerRef.current;
      if (!node) return;
      node.scrollTo({ top: node.scrollHeight, behavior });
    });
  }, [containerRef, setStick]);

  /**
   * Вешать на реальные жесты (touchmove/wheel), а НЕ на событие scroll.
   * Именно это отделяет "юзер уехал от низа" от "раскладка сдвинула ленту".
   */
  const noteUserGesture = useCallback(() => {
    gestureUntilRef.current = Date.now() + GESTURE_WINDOW_MS;
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const now = Date.now();
    // Вне окна жеста — этот scroll породила раскладка, а не человек. Режим
    // залипания не трогаем: раньше именно тут он и слетал сам по себе.
    if (now >= gestureUntilRef.current) return;
    // Инерция продлевает окно, пока события скролла продолжают приходить.
    gestureUntilRef.current = now + GESTURE_WINDOW_MS;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStick(distanceFromBottom < NEAR_BOTTOM_PX);
  }, [containerRef, setStick]);

  const handleTouchStart = useCallback(() => {
    isTouchingRef.current = true;
  }, []);

  const handleTouchEnd = useCallback(() => {
    isTouchingRef.current = false;
    if (!pendingPinRef.current) return;
    pendingPinRef.current = false;
    // Кадр запаса — чтобы не столкнуться с ещё не отыгравшей нативной
    // инерцией/отскоком у самого конца жеста.
    requestAnimationFrame(pin);
  }, [pin]);

  /**
   * Подгрузка истории вверх: контент вырастает сверху, и без коррекции лента
   * визуально прыгнула бы на высоту добавленного. Тоже проходит через этот
   * модуль, чтобы запись scrollTop оставалась в одном месте.
   */
  const preserveOnPrepend = useCallback((prevScrollHeight: number) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - prevScrollHeight;
  }, [containerRef]);

  /**
   * Любое изменение размера контента ленты — новое сообщение, схлопывание
   * удалённого (кадр за кадром), правка текста, догрузившаяся картинка,
   * сменившееся состояние голосового. Один наблюдатель на всё: неважно, что
   * именно изменило высоту, важно что она изменилась.
   *
   * Колбэк ResizeObserver выполняется до отрисовки кадра, так что коррекция
   * не успевает мигнуть.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => pin());
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, pin]);

  return {
    /** Держим ли сейчас низ ленты (для кнопки "вниз"). */
    isStuck,
    /** Текущее значение без ожидания рендера — для обработчиков и эффектов. */
    isStuckNow: useCallback(() => stickRef.current, []),
    settle,
    scrollToBottom,
    preserveOnPrepend,
    noteUserGesture,
    handleScroll,
    handleTouchStart,
    handleTouchEnd,
  };
}

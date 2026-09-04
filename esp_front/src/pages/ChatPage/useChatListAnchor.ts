import { useCallback, useEffect, useRef, useState } from 'react';

// Дальше этого от низа — показываем кнопку "вниз". Это ЧИСТО про кнопку и ни
// про что больше.
//
// Раньше это же число решало и второй, совершенно отдельный вопрос: держать ли
// низ при росте контента. Совмещение и было багом. Пока юзер оставался в этих
// 120px, режим залипания считался включённым — то есть pin() на каждое
// изменение высоты возвращал его вниз прямо поверх его же жеста. На колесе
// это значило, что в оживлённом чате отмотать на 40px просто невозможно:
// каждое новое сообщение отменяло прокрутку. На тач-устройствах pin() ждал
// touchend и дёргал ленту вниз ровно в момент, когда палец оторвали.
const FAR_FROM_BOTTOM_PX = 120;

// Порог возврата: юзер сам домотал вплотную к низу — снова держим низ за
// ним. Не 0, потому что дробный scrollTop (зум страницы, hidpi) до нуля не
// доезжает.
const AT_BOTTOM_PX = 8;

// Насколько надо увести ленту вверх, чтобы это считалось намерением уйти от
// низа, а не дрожанием пальца/тачпада.
const RELEASE_UP_PX = 4;

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

/** Точка привязки при подгрузке истории: сообщение и его позиция на экране. */
export interface TopAnchor {
  seq: string;
  top: number;
}

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
  // Ref, а не state: читается из обработчиков событий и из ResizeObserver, где
  // замыкание на state было бы устаревшим. В state он больше и не зеркалится —
  // из режима залипания ничего не рендерится (кнопка "вниз" теперь живёт на
  // своём собственном признаке, см. isFarFromBottom ниже), а с новым правилом
  // "любой жест вверх снимает залипание" такое зеркало давало бы ре-рендер
  // всей страницы чата на каждое движение пальца.
  const stickRef = useRef(true);

  // А вот это — рендерится, поэтому state. Меняется только на пересечении
  // порога, а не на каждое событие скролла: ref рядом гасит повторы.
  const farRef = useRef(false);
  const [isFarFromBottom, setIsFarFromBottom] = useState(false);

  // Ориентир для определения направления жеста. Держим отдельно от scrollTop
  // самой ленты: нам нужно "куда повёл ОТ предыдущего события скролла", а не
  // абсолютное положение.
  const lastScrollTopRef = useRef(0);

  // Палец сейчас на ленте. Программная запись scrollTop поверх активного
  // тач-жеста на iOS — известный триггер "заморозки" слоя скролла в
  // WKWebView (тот же класс бага, что раньше ловили на backdrop-filter меню
  // действий), поэтому пока палец на экране мы только запоминаем намерение.
  const isTouchingRef = useRef(false);
  const pendingPinRef = useRef(false);

  const gestureUntilRef = useRef(0);
  const smoothUntilRef = useRef(0);

  // Идёт подгрузка истории: позицию держит якорь (см. captureTopAnchor), и низ
  // сейчас не наш. Флаг нужен потому, что на короткой ленте верх ещё попадает
  // в NEAR_BOTTOM_PX, то есть режим залипания честно остаётся включённым — и
  // pin() из ResizeObserver на вставленной странице увёл бы ленту вниз прямо
  // поверх якоря.
  const prependingRef = useRef(false);

  const setStick = useCallback((next: boolean) => {
    stickRef.current = next;
  }, []);

  /**
   * Кнопка "вниз" — единственное, что осталось за порогом FAR_FROM_BOTTOM_PX.
   * Считается от фактического расстояния до низа, а не от режима залипания:
   * они теперь отвечают на разные вопросы. Зовётся и из обработчика скролла, и
   * из обоих наблюдателей размера — потому что уехать от низа можно не только
   * прокруткой, но и ростом контента под собой (лента выросла, а scrollTop
   * остался), а события scroll на это не приходит.
   */
  const syncScrollDownButton = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distanceFromBottom >= FAR_FROM_BOTTOM_PX;
    if (farRef.current === next) return;
    farRef.current = next;
    setIsFarFromBottom(next);
  }, [containerRef]);

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
    if (prependingRef.current) return;
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

    // Кнопке "вниз" безразлично, кто подвинул ленту, — она про факт, а не про
    // намерение. Поэтому считается до всех проверок на жест.
    syncScrollDownButton();

    const now = Date.now();
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    // Вне окна жеста — этот scroll породила раскладка, а не человек. Режим
    // залипания не трогаем: раньше именно тут он и слетал сам по себе.
    // Ориентир выше при этом всё равно обновили, иначе первое же настоящее
    // движение пальца сравнилось бы с давно устаревшим значением и приняло
    // чужой сдвиг за жест.
    if (now >= gestureUntilRef.current) return;
    // Инерция продлевает окно, пока события скролла продолжают приходить.
    gestureUntilRef.current = now + GESTURE_WINDOW_MS;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

    // Домотал вплотную к низу — снова держим низ за ним. Приоритетнее проверки
    // направления: последний кадр инерции у самой границы вполне может прийти
    // как микро-движение вверх, и трактовать его как уход было бы неверно.
    if (distanceFromBottom <= AT_BOTTOM_PX) {
      setStick(true);
      return;
    }

    // Повёл вверх — отпускаем низ, каким бы близким к нему юзер ни был. Это и
    // есть вся разница с прежним поведением: раньше жест внутри 120px не
    // считался уходом, и pin() возвращал ленту вниз поверх него.
    if (el.scrollTop < prevScrollTop - RELEASE_UP_PX) {
      setStick(false);
    }
    // Движение вниз, не дошедшее до самого низа, режим не меняет: юзер ещё в
    // пути, и решать за него рано.
  }, [containerRef, setStick, syncScrollDownButton]);

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
   * Подгрузка истории вверх: контент вырастает над текущей позицией, и без
   * коррекции лента визуально прыгнула бы на высоту добавленного.
   *
   * Держимся не за высоту ленты, а за конкретное сообщение: запоминаем, где на
   * экране стоит самое верхнее из уже загруженных, и после вставки страницы
   * возвращаем его туда же. Разница высот "до/после" для этого не годится —
   * между замером и вставкой лента успевает измениться сама по себе (пришло
   * сообщение по WS, догрузилась картинка, пропала плашка "прокрутите вверх",
   * когда история кончилась), и вся эта разница уехала бы в scrollTop ошибкой.
   * Точке на экране всё это безразлично.
   */
  const captureTopAnchor = useCallback((): TopAnchor | null => {
    const el = containerRef.current;
    const first = el?.querySelector<HTMLElement>('[data-seq]');
    if (!el || !first?.dataset.seq) return null;
    prependingRef.current = true;
    return { seq: first.dataset.seq, top: first.getBoundingClientRect().top };
  }, [containerRef]);

  /** Догрузка кончилась (страница вставлена, запрос упал, история исчерпана) —
      низ снова под обычными правилами. */
  const releaseTopAnchor = useCallback(() => {
    prependingRef.current = false;
  }, []);

  const restoreTopAnchor = useCallback((anchor: TopAnchor) => {
    const el = containerRef.current;
    // Сообщения-якоря нет — его удалили, пока грузилась страница. Вернуть
    // взгляд не к чему, а промахнуться мимо хуже, чем не трогать вовсе.
    const node = el?.querySelector<HTMLElement>(`[data-seq="${anchor.seq}"]`);
    if (!el || !node) return;
    const delta = node.getBoundingClientRect().top - anchor.top;
    if (delta) el.scrollTop += delta;
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
    const ro = new ResizeObserver(() => {
      pin();
      // Контент вырос под юзером, который низ не держит: событие scroll на это
      // не приходит, а от низа он уехал. Без этой строки кнопка "вниз" не
      // появилась бы, и он остался бы без единого признака, что внизу что-то
      // происходит — а с новым правилом отпускания низа отойти от него стало
      // куда проще, чем раньше.
      syncScrollDownButton();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, pin, syncScrollDownButton]);

  /**
   * Второй наблюдатель — на сам скролл-контейнер, и он про другое.
   *
   * Наблюдатель контента выше видит только высоту сообщений. А у ленты
   * меняются ещё и собственные отступы: ChatPage меряет реальную высоту
   * фиксированной шапки и фиксированного поля ввода и кладёт их в
   * padding-top/padding-bottom самой ленты, чтобы контент не залезал под них.
   * Растут они не от сообщений, а от раскладки ВОКРУГ ленты:
   *
   *   сверху — появился баннер закрепа (событие pinned по WS от другого
   *            юзера) или баннер уведомлений (асинхронная проверка push);
   *   снизу  — полоска "Ответ"/"Редактирование", ошибка отправки, поле
   *            ввода переросло в несколько строк.
   *
   * Высота контента при этом не меняется ни на пиксель, поэтому наблюдатель
   * контента молчит — и до этого места ни pin(), ни коррекции не случалось
   * вообще. Отсюда две болячки: чужой закреп сдвигал ленту под читающим, а
   * тап по "Ответить" на последнем сообщении прятал это же сообщение под
   * выросшим полем ввода — и там оно и оставалось, потому что режим залипания
   * честно оставался включённым и кнопка "вниз" даже не показывалась.
   *
   * Наблюдатель на контейнере это ловит: padding входит в его border-box, так
   * что при неизменной внешней высоте рост padding ужимает content-box, и
   * ResizeObserver срабатывает.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const readPadTop = (node: HTMLElement) => parseFloat(getComputedStyle(node).paddingTop) || 0;
    let prevPadTop = readPadTop(el);

    const ro = new ResizeObserver(() => {
      const node = containerRef.current;
      if (!node) return;
      const padTop = readPadTop(node);
      const delta = padTop - prevPadTop;
      prevPadTop = padTop;

      // Верхний отступ живёт НАД контентом: вырос на N — весь контент уехал
      // вниз на те же N при неизменном scrollTop (и вверх, когда схлопнулся).
      // Возвращаем взгляд на место той же N. Коррекция верна в любом режиме:
      // внизу она даёт ровно то же, что и pin() следом, а в истории она
      // единственная, кто вообще держит позицию.
      //
      // Кроме двух случаев, и оба — те же, что запрещают pin() писать scrollTop.
      //
      // Палец на ленте: писать scrollTop поверх живого тач-жеста нельзя (см.
      // isTouchingRef выше), а отложить до touchend нечего — к тому моменту
      // сдвиг уже отыгран на экране, и вторая коррекция стала бы вторым же
      // рывком вместо ни одного. Такой кадр отдаём как есть: баннер,
      // прилетевший ровно в те полсекунды, что палец ведёт ленту, — цена
      // заметно меньше подвисшего слоя скролла в WKWebView.
      //
      // Идущий smooth-скролл: позицией сейчас владеет анимация, и жёсткая
      // запись оборвала бы её на полпути — ровно то, ради чего окно
      // smoothUntilRef и заведено.
      const mayWrite = !isTouchingRef.current && Date.now() >= smoothUntilRef.current;
      if (Math.abs(delta) >= 0.5 && mayWrite) {
        node.scrollTop += delta;
      }

      // Нижний отступ контент не двигает, но съедает место под ним: если мы
      // держим низ, последнее сообщение только что ушло под поле ввода.
      pin();
      // Расстояние до низа изменилось вместе с отступом — кнопка про это ещё
      // не знает, событий scroll тут тоже не было.
      syncScrollDownButton();
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, pin, syncScrollDownButton]);

  return {
    /** Юзер достаточно далеко от низа, чтобы имело смысл показать кнопку "вниз".
        Именно расстояние, а НЕ режим залипания: уйти от низа теперь можно
        любым жестом вверх, и вешать кнопку на это было бы дёрганьем. */
    isFarFromBottom,
    /** Текущее значение без ожидания рендера — для обработчиков и эффектов. */
    isStuckNow: useCallback(() => stickRef.current, []),
    settle,
    scrollToBottom,
    captureTopAnchor,
    restoreTopAnchor,
    releaseTopAnchor,
    noteUserGesture,
    handleScroll,
    handleTouchStart,
    handleTouchEnd,
  };
}

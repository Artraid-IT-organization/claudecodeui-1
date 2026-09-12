# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Вид ленты ответов (`src/components/chat/view/subcomponents/Markdown.tsx`)

Три грабли, каждая стоила отдельной выкатки «ничего не изменилось»:

1. **Уровни заголовков сдвинуты.** `#` рендерится в `<h2>`, `##` — в `<h3>` и так
   далее: в документе остаётся один `h1`. Правила вида `.prose h1` в `index.css`
   промахиваются мимо и выглядят как рабочие.
2. **Размер заголовка задаётся в компоненте, не в CSS.** Utility-классы Tailwind
   (`text-[22px]`) лежат в слое выше `components`, поэтому `index.css` их не
   перебьёт. Меняешь кегль — меняй класс в `Markdown.tsx`.
3. **Абзац — это `div`, а не `p`,** и подзаголовок отличается от жирного слова
   только классом `md-subheading`, который ставит сам разметчик. Чистым CSS их не
   различить: `:only-child` считает теги и не видит текст вокруг, поэтому целился
   и в `текст <strong>слово</strong> текст`, разрывая абзац.

Правка вида проверяется снимком отрисованного элемента с ЖИВЫМ CSS с сервера, а
не `grep`'ом по `dist` — обе прошлые ошибки прошли проверку файлами.

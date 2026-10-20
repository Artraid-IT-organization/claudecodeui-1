/**
 * Прокрутка, после которой всплывающее меню (в портале, position: fixed)
 * действительно оторвалось от своей кнопки: прокрутилась страница целиком или
 * контейнер, внутри которого лежит кнопка.
 *
 * Зачем (Егор 14.10.26, Mac). Меню закрывались от ЛЮБОЙ прокрутки на странице
 * — в том числе ленты чата рядом, которая сама едет при догрузке и ответе.
 * Меню исчезало за миг до щелчка, и щелчок падал в то, что под ним (папку в
 * списке), — открывался «Новый сеанс» в чужой папке. На телефоне меню
 * перекрывает ленту, поэтому там этого не было.
 */
export function scrollMovesAnchor(event: Event, anchor: Element | null): boolean {
  const target = event.target;
  if (target === document || target === document.documentElement || target === document.body) {
    return true;
  }
  return Boolean(anchor && target instanceof Node && target.contains(anchor));
}

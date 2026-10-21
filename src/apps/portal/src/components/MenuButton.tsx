// Opens the list of requests on a phone.
export const MenuButton = ({ onClick }: { onClick: () => void }) => (
  <button className="menu-btn" aria-label="Mis pedidos" onClick={onClick}><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
);

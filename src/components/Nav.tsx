import ThemeSwitch from './ThemeSwitch';

function Nav() {
  return (
    <nav className="top">
      <a className="logo" href="#">
        {/* Swap this gradient square for your own mark: drop an image in
            src/assets/ and `import logo from '../assets/logo.png'`. */}
        <span className="mark" aria-hidden="true" />
        trololo
      </a>
      <div className="cta">
        <ThemeSwitch />
        <a className="btn btn-primary" href="https://immediately.run">
          immediately.run →
        </a>
      </div>
    </nav>
  );
}

export default Nav;

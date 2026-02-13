// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const href = this.getAttribute('href');
    if (href === '#') return;

    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  });
});

// Add active class to nav links on scroll
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');

function setActiveNav() {
  const scrollY = window.pageYOffset;

  sections.forEach(section => {
    const sectionHeight = section.offsetHeight;
    const sectionTop = section.offsetTop - 100;
    const sectionId = section.getAttribute('id');

    if (scrollY > sectionTop && scrollY <= sectionTop + sectionHeight) {
      navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href') === `#${sectionId}`) {
          link.classList.add('active');
        }
      });
    }
  });
}

window.addEventListener('scroll', setActiveNav);

// Fade in elements on scroll
const observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -100px 0px'
};

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, observerOptions);

// Observe feature cards and other elements
document.querySelectorAll('.feature-card, .security-item, .use-case, .screenshot-item').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  observer.observe(el);
});

// Copy code blocks on click
document.querySelectorAll('.code-block').forEach(block => {
  block.style.cursor = 'pointer';
  block.title = 'Click to copy';

  block.addEventListener('click', async () => {
    const code = block.querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(code);
      const originalBg = block.style.background;
      block.style.background = 'rgba(16, 185, 129, 0.1)';
      block.style.borderColor = 'rgba(16, 185, 129, 0.3)';

      setTimeout(() => {
        block.style.background = originalBg;
        block.style.borderColor = 'rgba(99, 102, 241, 0.2)';
      }, 500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });
});

// Add copy indicator to code blocks
document.querySelectorAll('.code-block').forEach(block => {
  const indicator = document.createElement('div');
  indicator.style.cssText = `
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    font-size: 0.75rem;
    color: #64748b;
    opacity: 0;
    transition: opacity 0.2s;
  `;
  indicator.textContent = 'Click to copy';

  block.style.position = 'relative';
  block.appendChild(indicator);

  block.addEventListener('mouseenter', () => {
    indicator.style.opacity = '1';
  });

  block.addEventListener('mouseleave', () => {
    indicator.style.opacity = '0';
  });
});

console.log('%cKatulong 🖥️', 'font-size: 24px; font-weight: bold; color: #6366f1;');
console.log('Check out the source code: https://github.com/Dorky-Robot/katulong');

// Image modal functionality
const modal = document.getElementById('imageModal');
const modalImg = document.getElementById('modalImage');
const modalCaption = document.getElementById('modalCaption');
const closeBtn = document.querySelector('.modal-close');

// Add click handlers to all screenshot images
document.querySelectorAll('.screenshot-item img').forEach(img => {
  img.addEventListener('click', function() {
    modal.style.display = 'block';
    modalImg.src = this.src;
    modalCaption.textContent = this.alt;
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
  });
});

// Close modal on X click
closeBtn.addEventListener('click', function() {
  modal.style.display = 'none';
  document.body.style.overflow = 'auto';
});

// Close modal on background click
modal.addEventListener('click', function(e) {
  if (e.target === modal) {
    modal.style.display = 'none';
    document.body.style.overflow = 'auto';
  }
});

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && modal.style.display === 'block') {
    modal.style.display = 'none';
    document.body.style.overflow = 'auto';
  }
});

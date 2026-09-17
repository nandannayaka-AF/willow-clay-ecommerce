// cart.js

// Shared cart functions used by multiple pages.

function loadCart() {
  const saved = localStorage.getItem('willowClayCart');

  return saved ? JSON.parse(saved) : [];
}


function saveCart(cart) {
  localStorage.setItem(
    'willowClayCart',
    JSON.stringify(cart)
  );
}


function addToCart(cart, product) {
  const existingItem = cart.find(
    item => item.id === product.id
  );

  if (existingItem) {
    if (Number.isInteger(product.stock) && existingItem.quantity >= product.stock) {
      return false;
    }
    existingItem.quantity += 1;
  } else {
    if (Number(product.stock) < 1) {
      return false;
    }
    cart.push({
      ...product,
      quantity: 1
    });
  }

  return true;
}


function clearCart() {
  localStorage.removeItem('willowClayCart');
}
